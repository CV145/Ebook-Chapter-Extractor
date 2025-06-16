// State management
let currentBook = null;
let currentChapterContent = '';

// IndexedDB configuration
const DB_NAME = 'EpubExtractorDB';
const DB_VERSION = 1;
const BOOKS_STORE = 'books';
const EPUB_STORE = 'epubFiles';

// IndexedDB utility functions
class EpubDB {
    constructor() {
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // Create books store for metadata
                if (!db.objectStoreNames.contains(BOOKS_STORE)) {
                    const booksStore = db.createObjectStore(BOOKS_STORE, { keyPath: 'id' });
                    booksStore.createIndex('title', 'title', { unique: false });
                }
                
                // Create epub files store for binary data
                if (!db.objectStoreNames.contains(EPUB_STORE)) {
                    db.createObjectStore(EPUB_STORE, { keyPath: 'id' });
                }
            };
        });
    }

    async addBook(book, epubBlob) {
        const transaction = this.db.transaction([BOOKS_STORE, EPUB_STORE], 'readwrite');
        
        try {
            // Store book metadata
            await this.promisifyRequest(
                transaction.objectStore(BOOKS_STORE).add(book)
            );
            
            // Store EPUB file
            await this.promisifyRequest(
                transaction.objectStore(EPUB_STORE).add({
                    id: book.id,
                    file: epubBlob,
                    timestamp: Date.now()
                })
            );
            
            return book;
        } catch (error) {
            transaction.abort();
            throw error;
        }
    }

    async getAllBooks() {
        const transaction = this.db.transaction([BOOKS_STORE], 'readonly');
        const request = transaction.objectStore(BOOKS_STORE).getAll();
        return this.promisifyRequest(request);
    }

    async getBook(id) {
        const transaction = this.db.transaction([BOOKS_STORE], 'readonly');
        const request = transaction.objectStore(BOOKS_STORE).get(id);
        return this.promisifyRequest(request);
    }

    async getEpubFile(id) {
        const transaction = this.db.transaction([EPUB_STORE], 'readonly');
        const request = transaction.objectStore(EPUB_STORE).get(id);
        const result = await this.promisifyRequest(request);
        return result ? result.file : null;
    }

    async deleteBook(id) {
        const transaction = this.db.transaction([BOOKS_STORE, EPUB_STORE], 'readwrite');
        
        try {
            await this.promisifyRequest(
                transaction.objectStore(BOOKS_STORE).delete(id)
            );
            await this.promisifyRequest(
                transaction.objectStore(EPUB_STORE).delete(id)
            );
        } catch (error) {
            transaction.abort();
            throw error;
        }
    }

    async getStorageEstimate() {
        if ('storage' in navigator && 'estimate' in navigator.storage) {
            return await navigator.storage.estimate();
        }
        return null;
    }

    promisifyRequest(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
}

// Global database instance
const epubDB = new EpubDB();

// PDF parsing functions
class PDFParser {
    static async parsePDF(arrayBuffer) {
        // Check if PDF.js is loaded
        if (typeof pdfjsLib === 'undefined') {
            throw new Error('PDF.js library not loaded');
        }
        
        // Validate input
        if (!arrayBuffer || arrayBuffer.byteLength === 0) {
            throw new Error('Invalid PDF: Empty or corrupted file');
        }
        
        try {
            console.log('Loading PDF document, size:', arrayBuffer.byteLength);
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            const numPages = pdf.numPages;
            
            // Extract title from metadata or use filename
            const metadata = await pdf.getMetadata();
            const title = metadata.info.Title || 'PDF Document';
            
            // Try to extract real chapters from PDF structure
            let chapters = await this.extractChaptersFromOutline(pdf);
            
            // If no outline found, try to extract from TOC page
            if (!chapters || chapters.length === 0) {
                console.log('No PDF outline found, looking for Table of Contents page...');
                chapters = await this.extractChaptersFromTOC(pdf, numPages);
            }
            
            // If no TOC found, try to detect chapters from content
            if (!chapters || chapters.length === 0) {
                console.log('No TOC found, detecting chapters from content...');
                chapters = await this.detectChaptersFromContent(pdf, numPages);
            }
            
            // If still no chapters found, fall back to page-based chapters
            if (!chapters || chapters.length === 0) {
                console.log('No chapters detected, creating page-based chapters...');
                chapters = await this.createPageBasedChapters(pdf, numPages);
            }
            
            return { title, chapters, numPages, type: 'pdf' };
        } catch (error) {
            console.error('Error parsing PDF:', error);
            throw error;
        }
    }
    
    static async extractChaptersFromOutline(pdf) {
        try {
            const outline = await pdf.getOutline();
            if (!outline || outline.length === 0) {
                return null;
            }
            
            const chapters = [];
            const allOutlineItems = [];
            
            // Flatten the outline structure (handle nested items)
            const flattenOutline = async (items, level = 0, parentTitle = '') => {
                for (const item of items) {
                    if (item.dest) {
                        try {
                            const destination = await pdf.getDestination(item.dest);
                            if (destination) {
                                const pageIndex = await pdf.getPageIndex(destination[0]);
                                allOutlineItems.push({
                                    title: item.title,
                                    pageNumber: pageIndex + 1,
                                    level: level,
                                    parentTitle: parentTitle
                                });
                            }
                        } catch (e) {
                            console.warn('Error processing outline item:', item.title, e);
                        }
                    }
                    
                    // Process nested items
                    if (item.items && item.items.length > 0) {
                        await flattenOutline(item.items, level + 1, item.title);
                    }
                }
            };
            
            // Flatten the entire outline
            await flattenOutline(outline);
            
            // Sort by page number
            allOutlineItems.sort((a, b) => a.pageNumber - b.pageNumber);
            
            console.log('All outline items:', allOutlineItems.map(item => 
                `${item.title} (level ${item.level}, page ${item.pageNumber})`
            ));
            
            // First, identify what constitutes a main chapter vs subsection
            // Look for common patterns across all items
            const hasNumericChapters = allOutlineItems.some(item => 
                item.title.match(/^(Chapter|CHAPTER)\s+\d+/i)
            );
            
            const hasNumericSections = allOutlineItems.some(item => 
                item.title.match(/^\d+\.\d+/)
            );
            
            // Group items by main chapters
            const mainChapters = [];
            
            for (let i = 0; i < allOutlineItems.length; i++) {
                const item = allOutlineItems[i];
                let isMainChapter = false;
                
                // Determine if this is a main chapter
                if (hasNumericChapters) {
                    // If we have "Chapter X" format, only those are main chapters
                    isMainChapter = item.title.match(/^(Chapter|CHAPTER)\s+\d+/i) !== null;
                } else if (hasNumericSections) {
                    // If we have numeric sections, main chapters are those without dots
                    isMainChapter = item.level === 0 || 
                        (item.title.match(/^\d+\.?\s/) && !item.title.match(/^\d+\.\d+/));
                } else {
                    // Otherwise, use level 0 items as main chapters
                    isMainChapter = item.level === 0;
                }
                
                // Also include common book sections as main chapters
                const isSpecialSection = item.title.match(
                    /^(Introduction|Conclusion|Preface|Epilogue|Appendix|Bibliography|References|Index|Foreword|Acknowledgments)$/i
                );
                
                if (isMainChapter || isSpecialSection) {
                    // Find where this chapter ends
                    let endPage = pdf.numPages;
                    
                    // Look for the next main chapter
                    for (let j = i + 1; j < allOutlineItems.length; j++) {
                        const nextItem = allOutlineItems[j];
                        let isNextMainChapter = false;
                        
                        if (hasNumericChapters) {
                            isNextMainChapter = nextItem.title.match(/^(Chapter|CHAPTER)\s+\d+/i) !== null;
                        } else if (hasNumericSections) {
                            isNextMainChapter = nextItem.level === 0 || 
                                (nextItem.title.match(/^\d+\.?\s/) && !nextItem.title.match(/^\d+\.\d+/));
                        } else {
                            isNextMainChapter = nextItem.level === 0;
                        }
                        
                        const isNextSpecialSection = nextItem.title.match(
                            /^(Introduction|Conclusion|Preface|Epilogue|Appendix|Bibliography|References|Index|Foreword|Acknowledgments)$/i
                        );
                        
                        if (isNextMainChapter || isNextSpecialSection) {
                            endPage = nextItem.pageNumber - 1;
                            break;
                        }
                    }
                    
                    mainChapters.push({
                        title: item.title,
                        startPage: item.pageNumber,
                        endPage: endPage,
                        type: 'pdf-chapter'
                    });
                }
            }
            
            // If we found main chapters, return them
            if (mainChapters.length > 0) {
                console.log(`Found ${mainChapters.length} main chapters from outline`);
                return mainChapters;
            }
            
            // Otherwise, return all level-0 items
            console.log('No clear chapter structure found, using all top-level items');
            const level0Items = allOutlineItems.filter(item => item.level === 0);
            for (let i = 0; i < level0Items.length; i++) {
                const item = level0Items[i];
                const nextItem = level0Items[i + 1];
                
                chapters.push({
                    title: item.title,
                    startPage: item.pageNumber,
                    endPage: nextItem ? nextItem.pageNumber - 1 : pdf.numPages,
                    type: 'pdf-chapter'
                });
            }
            
            return chapters;
        } catch (error) {
            console.log('Error extracting outline:', error);
            return null;
        }
    }
    
    static async extractChaptersFromTOC(pdf, numPages) {
        const chapters = [];
        let tocPageNum = null;
        
        // First, find the TOC page
        for (let pageNum = 1; pageNum <= Math.min(20, numPages); pageNum++) {
            try {
                const page = await pdf.getPage(pageNum);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map(item => item.str).join(' ').toLowerCase();
                
                // Look for TOC indicators
                if (pageText.includes('table of contents') || 
                    pageText.includes('contents') || 
                    pageText.includes('índice') ||
                    pageText.match(/^\s*contents\s*$/)) {
                    tocPageNum = pageNum;
                    console.log(`Found TOC on page ${pageNum}`);
                    break;
                }
            } catch (error) {
                console.warn(`Error checking page ${pageNum} for TOC:`, error);
            }
        }
        
        if (!tocPageNum) {
            return null;
        }
        
        // Extract chapters from TOC
        try {
            const tocPage = await pdf.getPage(tocPageNum);
            const textContent = await tocPage.getTextContent();
            const items = textContent.items;
            
            // First, try to get clickable links from the TOC page
            const annotations = await tocPage.getAnnotations();
            const linkAnnotations = annotations.filter(ann => ann.subtype === 'Link' && ann.dest);
            
            console.log(`Found ${linkAnnotations.length} clickable links on TOC page`);
            
            if (linkAnnotations.length > 0) {
                return await this.extractChaptersFromTOCLinks(pdf, linkAnnotations, numPages, tocPageNum);
            }
            
            // Group items by Y position (same line)
            const lines = [];
            let currentLine = [];
            let lastY = null;
            
            for (const item of items) {
                const y = Math.round(item.transform[5]);
                
                if (lastY !== null && Math.abs(y - lastY) > 5) {
                    // New line
                    if (currentLine.length > 0) {
                        lines.push({
                            y: lastY,
                            text: currentLine.map(i => i.str).join(' ').trim(),
                            items: currentLine
                        });
                    }
                    currentLine = [item];
                } else {
                    currentLine.push(item);
                }
                lastY = y;
            }
            
            // Add last line
            if (currentLine.length > 0) {
                lines.push({
                    y: lastY,
                    text: currentLine.map(i => i.str).join(' ').trim(),
                    items: currentLine
                });
            }
            
            // Parse TOC entries
            const tocEntries = [];
            const pageNumberPattern = /\.{3,}|\s{3,}|\s+(\d+)\s*$/;
            
            for (const line of lines) {
                const text = line.text;
                
                // Skip empty lines or TOC header
                if (!text || text.toLowerCase().includes('table of contents')) {
                    continue;
                }
                
                // Look for page numbers at the end
                const pageMatch = text.match(/(\d+)\s*$/);
                if (pageMatch) {
                    const pageNum = parseInt(pageMatch[1]);
                    const title = text.substring(0, pageMatch.index).replace(/\.+$/, '').trim();
                    
                    // Skip if title is too short or looks like a page number itself
                    if (title.length > 2 && !title.match(/^\d+$/)) {
                        tocEntries.push({
                            title: title,
                            tocPageNum: pageNum,  // Page number shown in TOC
                            pageNum: pageNum      // Will be adjusted later
                        });
                    }
                }
            }
            
            // Log all found entries for debugging
            console.log('All TOC entries found:', tocEntries);
            
            // Filter to main chapters only (no subsections)
            const mainChapters = tocEntries.filter(entry => {
                // Skip subsections like "1.1", "2.3.4"
                if (entry.title.match(/^\d+\.\d+/)) return false;
                
                // Skip if it's just a number
                if (entry.title.match(/^\d+$/)) return false;
                
                // Keep everything else as potential chapters
                return true;
            });
            
            // If too few main chapters, be less restrictive
            if (mainChapters.length < 3) {
                console.log('Too few main chapters found, using all TOC entries');
                return tocEntries.map((entry, i) => ({
                    title: entry.title,
                    startPage: entry.pageNum,
                    endPage: tocEntries[i + 1] ? tocEntries[i + 1].pageNum - 1 : numPages,
                    type: 'pdf-chapter'
                }));
            }
            
            // Calculate page offset by finding the first few chapters
            console.log('Calculating page number offset...');
            let pageOffset = 0;
            const offsetSamples = [];
            
            // Try to find the first few chapters to calculate offset
            for (let i = 0; i < Math.min(3, mainChapters.length); i++) {
                const entry = mainChapters[i];
                
                // Search for the chapter title in the PDF
                // Typically the actual page is after the TOC page
                const searchStart = Math.max(tocPageNum, entry.tocPageNum - 5);
                const searchEnd = Math.min(numPages, entry.tocPageNum + 50);
                
                for (let pageNum = searchStart; pageNum <= searchEnd; pageNum++) {
                    try {
                        const page = await pdf.getPage(pageNum);
                        const textContent = await page.getTextContent();
                        
                        // Get first few text items (usually chapter headings)
                        const firstTexts = textContent.items.slice(0, 10).map(item => item.str).join(' ');
                        
                        // Check if this page starts with the chapter title
                        const cleanTitle = entry.title.toLowerCase().replace(/[^\w\s]/g, '').trim();
                        const cleanPageText = firstTexts.toLowerCase().replace(/[^\w\s]/g, '');
                        
                        if (cleanPageText.includes(cleanTitle)) {
                            const offset = pageNum - entry.tocPageNum;
                            offsetSamples.push(offset);
                            console.log(`Found "${entry.title}" on PDF page ${pageNum} (TOC page ${entry.tocPageNum}) - offset: ${offset}`);
                            break;
                        }
                    } catch (error) {
                        console.warn(`Error searching page ${pageNum}:`, error);
                    }
                }
            }
            
            // Calculate average offset
            if (offsetSamples.length > 0) {
                pageOffset = Math.round(offsetSamples.reduce((a, b) => a + b) / offsetSamples.length);
                console.log(`Detected page offset: ${pageOffset} (TOC page + ${pageOffset} = actual PDF page)`);
            } else {
                console.warn('Could not detect page offset, using TOC page numbers as-is');
            }
            
            // Create chapter objects with corrected page ranges
            for (let i = 0; i < mainChapters.length; i++) {
                const entry = mainChapters[i];
                const nextEntry = mainChapters[i + 1];
                
                // Apply the offset to get actual PDF pages
                const actualStartPage = entry.tocPageNum + pageOffset;
                const actualEndPage = nextEntry ? (nextEntry.tocPageNum + pageOffset - 1) : numPages;
                
                chapters.push({
                    title: entry.title,
                    startPage: actualStartPage,
                    endPage: actualEndPage,
                    type: 'pdf-chapter'
                });
            }
            
            if (chapters.length > 0) {
                console.log(`Extracted ${chapters.length} chapters from TOC`);
            }
            
            return chapters;
            
        } catch (error) {
            console.error('Error extracting chapters from TOC:', error);
            return null;
        }
    }
    
    static async extractChaptersFromTOCLinks(pdf, linkAnnotations, numPages, tocPageNum) {
        const chapters = [];
        const linkDestinations = [];
        
        try {
            console.log(`Starting to process ${linkAnnotations.length} link annotations`);
            
            // Get the destination page for each link
            for (let i = 0; i < linkAnnotations.length; i++) {
                const annotation = linkAnnotations[i];
                console.log(`Processing link ${i + 1}/${linkAnnotations.length}:`, {
                    dest: annotation.dest,
                    rect: annotation.rect,
                    url: annotation.url
                });
                
                try {
                    let pageIndex;
                    
                    // Handle different destination formats
                    if (annotation.dest) {
                        if (typeof annotation.dest === 'string') {
                            console.log(`Link ${i + 1}: Named destination "${annotation.dest}"`);
                            const destination = await pdf.getDestination(annotation.dest);
                            console.log(`Destination resolved to:`, destination);
                            if (destination && destination[0]) {
                                pageIndex = await pdf.getPageIndex(destination[0]);
                            }
                        } else if (Array.isArray(annotation.dest) && annotation.dest[0]) {
                            console.log(`Link ${i + 1}: Direct destination array`);
                            pageIndex = await pdf.getPageIndex(annotation.dest[0]);
                        }
                    } else if (annotation.url && annotation.url.startsWith('#')) {
                        // Handle internal URL links like "#page=5"
                        console.log(`Link ${i + 1}: Internal URL "${annotation.url}"`);
                        const pageMatch = annotation.url.match(/#page=(\d+)/);
                        if (pageMatch) {
                            pageIndex = parseInt(pageMatch[1]) - 1; // Convert to 0-based index
                        }
                    }
                    
                    if (pageIndex !== undefined) {
                        const pageNum = pageIndex + 1;
                        console.log(`Link ${i + 1}: Points to page ${pageNum}`);
                        
                        // Get the text content around this link to extract the chapter title
                        const rect = annotation.rect;
                        const linkText = await this.getTextNearRect(pdf, tocPageNum, rect);
                        
                        console.log(`Link ${i + 1}: Text extracted: "${linkText}"`);
                        
                        // If we can't extract good text, create a generic title
                        let finalTitle = linkText;
                        if (!finalTitle || finalTitle.length < 2) {
                            finalTitle = `Section ${linkDestinations.length + 1}`;
                            console.log(`Link ${i + 1}: Using generic title "${finalTitle}"`);
                        }
                        
                        linkDestinations.push({
                            title: finalTitle,
                            pageNum: pageNum,
                            rect: rect
                        });
                        console.log(`Link ${i + 1}: Added to destinations as "${finalTitle}"`);
                    } else {
                        console.warn(`Link ${i + 1}: Could not determine page index`);
                    }
                } catch (error) {
                    console.warn(`Error processing link ${i + 1}:`, error);
                }
            }
            
            console.log(`FINAL: linkDestinations array has ${linkDestinations.length} items:`, linkDestinations);
            
            // Sort by page number
            linkDestinations.sort((a, b) => a.pageNum - b.pageNum);
            
            // Remove duplicates but keep all sections
            const allChapters = [];
            const seenPageNums = new Set();
            
            console.log('All link destinations found:', linkDestinations);
            
            for (const dest of linkDestinations) {
                // Skip if we already have this exact page
                if (seenPageNums.has(dest.pageNum)) continue;
                seenPageNums.add(dest.pageNum);
                
                // Skip if title is too short or just whitespace
                if (!dest.title || dest.title.length < 2) continue;
                
                allChapters.push(dest);
            }
            
            // Sort by page number to ensure proper order
            allChapters.sort((a, b) => a.pageNum - b.pageNum);
            
            // Create chapter objects with page ranges from ALL links
            for (let i = 0; i < allChapters.length; i++) {
                const chapter = allChapters[i];
                const nextChapter = allChapters[i + 1];
                
                chapters.push({
                    title: chapter.title,
                    startPage: chapter.pageNum,
                    endPage: nextChapter ? nextChapter.pageNum - 1 : numPages,
                    type: 'pdf-chapter'
                });
                
                console.log(`Chapter: "${chapter.title}" - Pages ${chapter.pageNum} to ${nextChapter ? nextChapter.pageNum - 1 : numPages}`);
            }
            
            if (chapters.length > 0) {
                console.log(`SUCCESS: Extracted ${chapters.length} chapters from TOC links`);
                console.log('Final chapters array:', chapters);
                return chapters;
            } else {
                console.warn('No chapters created from TOC links - falling back');
            }
            
        } catch (error) {
            console.error('ERROR in extractChaptersFromTOCLinks:', error);
            console.error('Stack trace:', error.stack);
        }
        
        console.log('Returning null from extractChaptersFromTOCLinks');
        return null;
    }
    
    static async getTextNearRect(pdf, pageNum, rect) {
        try {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            
            // Find text items that overlap with the link rectangle
            const [x1, y1, x2, y2] = rect;
            const linkTexts = [];
            
            console.log(`Searching for text near rect [${x1}, ${y1}, ${x2}, ${y2}] on page ${pageNum}`);
            
            // Use tight bounds for link rectangle - only get text directly under the link
            const margin = 5; // Much smaller margin for precision
            
            for (const item of textContent.items) {
                const itemX = item.transform[4];
                const itemY = item.transform[5];
                const itemWidth = item.width || 0;
                const itemHeight = item.height || 10;
                
                // Check if text item overlaps with the link rectangle (tight bounds)
                if (itemX >= x1 - margin && itemX <= x2 + margin && 
                    itemY >= y1 - margin && itemY <= y2 + margin) {
                    if (item.str.trim()) {
                        linkTexts.push(item.str.trim());
                        console.log(`Found text in link: "${item.str.trim()}" at [${itemX}, ${itemY}]`);
                    }
                }
            }
            
            // Join the text found directly under the link
            let fullText = linkTexts.join(' ').trim();
            
            // Clean up the text to extract just the chapter title
            if (fullText) {
                // Look for chapter patterns and extract just that part
                const chapterMatch = fullText.match(/(Chapter\s+\d+[^.]*?)(?:\s*\.{3,}|\s+\d+|$)/i);
                if (chapterMatch) {
                    fullText = chapterMatch[1].trim();
                } else {
                    // Try other patterns
                    const patterns = [
                        /(\d+\.\d+\s+[^.]+?)(?:\s*\.{3,}|\s+\d+|$)/,  // "1.1 Section Name"
                        /(\d+\s+[^.]+?)(?:\s*\.{3,}|\s+\d+|$)/,       // "1 Section Name"
                        /([A-Z][^.]+?)(?:\s*\.{3,}|\s+\d+|$)/        // "Appendix A"
                    ];
                    
                    for (const pattern of patterns) {
                        const match = fullText.match(pattern);
                        if (match) {
                            fullText = match[1].trim();
                            break;
                        }
                    }
                }
                
                // Remove trailing dots and page numbers
                fullText = fullText.replace(/\.+$/, '').replace(/\s+\d+\s*$/, '').trim();
                
                // If text is too long, truncate at first sentence or reasonable length
                if (fullText.length > 60) {
                    const firstSentence = fullText.split('.')[0];
                    if (firstSentence.length > 10 && firstSentence.length < fullText.length) {
                        fullText = firstSentence;
                    } else {
                        fullText = fullText.substring(0, 60).trim();
                    }
                }
            }
            
            console.log(`Final extracted text: "${fullText}"`);
            return fullText;
            
        } catch (error) {
            console.warn('Error getting text near rect:', error);
            return '';
        }
    }
    
    static async detectChaptersFromContent(pdf, numPages) {
        const chapters = [];
        const mainChapterPatterns = [
            /^(Chapter|CHAPTER|Chap\.?)\s+(\d+|[IVXLCDM]+)(?:\s|:|$)/,
            /^(Part|PART)\s+(\d+|[IVXLCDM]+)(?:\s|:|$)/,
            /^(\d+)\.(?:\s+\w+|$)/,  // "1. Introduction" or just "1."
            /^(Introduction|Conclusion|Preface|Epilogue|Appendix|Bibliography|References|Index)$/i,
            /^(Foreword|Acknowledgments|Dedication|Abstract|Summary)$/i
        ];
        
        const subsectionPatterns = [
            /^\d+\.\d+/,  // "1.1", "2.3", etc.
            /^(Section|SECTION|Sec\.?)\s+\d+\.\d+/
        ];
        
        const potentialChapters = [];
        const seenChapters = new Map(); // Track chapter numbers to avoid duplicates
        
        // First pass: collect all potential chapter headings
        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            try {
                const page = await pdf.getPage(pageNum);
                const textContent = await page.getTextContent();
                
                // Combine text items to handle split headings
                let pageText = '';
                const firstItems = [];
                
                for (let i = 0; i < Math.min(10, textContent.items.length); i++) {
                    const item = textContent.items[i];
                    if (item.str.trim()) {
                        firstItems.push({
                            text: item.str.trim(),
                            fontSize: item.height,
                            y: item.transform[5]
                        });
                        pageText += item.str + ' ';
                    }
                }
                
                // Skip if this looks like a subsection
                const combinedText = pageText.trim();
                let isSubsection = false;
                for (const pattern of subsectionPatterns) {
                    if (pattern.test(combinedText)) {
                        isSubsection = true;
                        break;
                    }
                }
                
                if (!isSubsection) {
                    // Check for main chapter patterns
                    for (const pattern of mainChapterPatterns) {
                        const match = combinedText.match(pattern);
                        if (match) {
                            // Extract chapter number if present
                            const chapterNumMatch = match[0].match(/(\d+|[IVXLCDM]+)/);
                            const chapterNum = chapterNumMatch ? chapterNumMatch[0] : match[0];
                            
                            // Check if we've already seen this chapter
                            if (!seenChapters.has(chapterNum)) {
                                seenChapters.set(chapterNum, true);
                                
                                const largestItem = firstItems.length > 0 ? 
                                    firstItems.reduce((prev, current) => 
                                        (current.fontSize > prev.fontSize) ? current : prev
                                    ) : { fontSize: 12 };
                                
                                potentialChapters.push({
                                    title: match[0],
                                    pageNum: pageNum,
                                    fontSize: largestItem.fontSize,
                                    chapterNum: chapterNum
                                });
                            }
                            break;
                        }
                    }
                }
            } catch (error) {
                console.warn(`Error processing page ${pageNum}:`, error);
            }
        }
        
        // Create final chapter list with proper page ranges
        for (let i = 0; i < potentialChapters.length; i++) {
            const chapter = potentialChapters[i];
            const nextChapter = potentialChapters[i + 1];
            
            chapters.push({
                title: chapter.title,
                startPage: chapter.pageNum,
                endPage: nextChapter ? nextChapter.pageNum - 1 : numPages,
                type: 'pdf-chapter'
            });
        }
        
        return chapters;
    }
    
    static async createPageBasedChapters(pdf, numPages) {
        // Fallback: Create single chapter for entire document
        return [{
            title: 'Full Document',
            startPage: 1,
            endPage: numPages,
            type: 'pdf-full'
        }];
    }
    
    static async extractTextFromPDFRange(arrayBuffer, startPage, endPage) {
        // Check if PDF.js is loaded
        if (typeof pdfjsLib === 'undefined') {
            throw new Error('PDF.js library not loaded');
        }
        
        try {
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            let fullText = '';
            
            for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
                const page = await pdf.getPage(pageNum);
                const textContent = await page.getTextContent();
                
                // Extract text from page
                let pageText = '';
                for (const item of textContent.items) {
                    if (item.str) {
                        pageText += item.str + ' ';
                    }
                }
                
                // Add page break and page number
                if (pageText.trim()) {
                    fullText += `\n\n--- Page ${pageNum} ---\n\n`;
                    fullText += pageText.trim() + '\n';
                }
            }
            
            return fullText.trim();
        } catch (error) {
            console.error('Error extracting PDF text:', error);
            return `[Error extracting text from pages ${startPage}-${endPage}]`;
        }
    }
}

// DOM elements
const fileInput = document.getElementById('file-input');
const uploadBtn = document.getElementById('upload-btn');
const uploadSection = document.getElementById('upload-section');
const booksSection = document.getElementById('books-section');
const chaptersSection = document.getElementById('chapters-section');
const contentSection = document.getElementById('content-section');
const booksList = document.getElementById('books-list');
const chaptersList = document.getElementById('chapters-list');
const bookTitle = document.getElementById('book-title');
const chapterTitle = document.getElementById('chapter-title');
const chapterContent = document.getElementById('chapter-content');
const downloadBtn = document.getElementById('download-btn');
const downloadFullBookBtn = document.getElementById('download-full-book');
const loadingIndicator = document.getElementById('loading-indicator');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const backToBooks = document.getElementById('back-to-books');
const backToChapters = document.getElementById('back-to-chapters');

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await epubDB.init();
        await migrateFromLocalStorage();
        await loadBooks();
        
        // Check if PDF.js loaded
        if (typeof pdfjsLib !== 'undefined') {
            console.log('PDF.js loaded successfully');
        } else {
            console.warn('PDF.js not loaded - PDF support will be disabled');
        }
    } catch (error) {
        console.error('Failed to initialize database:', error);
        alert('Failed to initialize storage. Some features may not work.');
    }
    
    uploadBtn.addEventListener('click', handleUpload);
    backToBooks.addEventListener('click', showBooksSection);
    backToChapters.addEventListener('click', () => showChaptersSection(currentBook));
    downloadBtn.addEventListener('click', downloadChapter);
    downloadFullBookBtn.addEventListener('click', downloadFullBook);
});

// Migrate existing data from localStorage to IndexedDB
async function migrateFromLocalStorage() {
    try {
        const oldBooksJson = localStorage.getItem('epubBooks');
        if (!oldBooksJson) {
            return; // No old data to migrate
        }
        
        const oldBooks = JSON.parse(oldBooksJson);
        if (oldBooks.length === 0) {
            localStorage.removeItem('epubBooks');
            return;
        }
        
        // Check if migration already happened
        const existingBooks = await epubDB.getAllBooks();
        if (existingBooks.length > 0) {
            return; // Already migrated or has new data
        }
        
        console.log('Found old localStorage data, but cannot migrate EPUB files. Old data will be cleared.');
        
        // Clear old localStorage data since we can't migrate without original EPUB files
        localStorage.removeItem('epubBooks');
        
        // Clear any old epub_ keys
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('epub_')) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));
        
    } catch (error) {
        console.error('Error during migration:', error);
    }
}

// Load books from IndexedDB
async function loadBooks() {
    try {
        const books = await epubDB.getAllBooks();
        if (books.length > 0) {
            showBooksSection();
            renderBooksList(books);
        }
    } catch (error) {
        console.error('Error loading books:', error);
    }
}

// Handle file upload
async function handleUpload() {
    const file = fileInput.files[0];
    if (!file) {
        alert('Please select a file');
        return;
    }
    
    const isEpub = file.name.toLowerCase().endsWith('.epub');
    const isPdf = file.name.toLowerCase().endsWith('.pdf');
    
    if (!isEpub && !isPdf) {
        alert('Please select a valid EPUB or PDF file');
        return;
    }
    
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Processing...';
    
    try {
        const arrayBuffer = await file.arrayBuffer();
        let bookData;
        let fileBlob;
        
        if (isEpub) {
            // Process EPUB
            const zip = await JSZip.loadAsync(arrayBuffer);
            const epubData = await parseEpubStructure(zip);
            
            bookData = {
                id: Date.now().toString(),
                title: epubData.title || file.name.replace('.epub', ''),
                fileName: file.name,
                chapters: epubData.chapters,
                uploadDate: new Date().toISOString(),
                fileSize: file.size,
                type: 'epub'
            };
            
            fileBlob = new Blob([arrayBuffer], { type: 'application/epub+zip' });
            
        } else if (isPdf) {
            // Process PDF
            console.log('Processing PDF, size:', arrayBuffer.byteLength);
            
            if (arrayBuffer.byteLength === 0) {
                throw new Error('PDF file is empty');
            }
            
            const pdfData = await PDFParser.parsePDF(arrayBuffer);
            
            bookData = {
                id: Date.now().toString(),
                title: pdfData.title || file.name.replace('.pdf', ''),
                fileName: file.name,
                chapters: pdfData.chapters,
                uploadDate: new Date().toISOString(),
                fileSize: file.size,
                numPages: pdfData.numPages,
                type: 'pdf'
            };
            
            // Store the original file blob, not arrayBuffer
            fileBlob = file;
        }
        
        // Save to IndexedDB
        await epubDB.addBook(bookData, fileBlob);
        
        // Clear file input and refresh books list
        fileInput.value = '';
        await loadBooks();
        
    } catch (error) {
        console.error('Error processing file:', error);
        if (error.name === 'QuotaExceededError') {
            alert('Storage quota exceeded. Please delete some books or try a smaller file.');
        } else {
            alert('Error processing file. Please try another file.');
        }
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload';
    }
}

// Parse EPUB structure (metadata only, no content extraction during upload)
async function parseEpubStructure(zip) {
    const opfPath = await findOpfPath(zip);
    const opfContent = await zip.file(opfPath).async('string');
    const parser = new DOMParser();
    const opfDoc = parser.parseFromString(opfContent, 'application/xml');
    
    // Get title
    const titleElement = opfDoc.querySelector('metadata title');
    const title = titleElement ? titleElement.textContent.trim() : 'Unknown Title';
    
    // Get spine items (reading order)
    const spine = opfDoc.querySelector('spine');
    const itemrefs = spine ? Array.from(spine.querySelectorAll('itemref')) : [];
    
    // Get manifest items
    const manifest = opfDoc.querySelector('manifest');
    const items = manifest ? Array.from(manifest.querySelectorAll('item')) : [];
    
    // Build chapters array with just metadata
    const chapters = [];
    for (const itemref of itemrefs) {
        const idref = itemref.getAttribute('idref');
        const item = items.find(i => i.getAttribute('id') === idref);
        
        if (item && item.getAttribute('media-type') === 'application/xhtml+xml') {
            const href = item.getAttribute('href');
            const fullPath = opfPath.substring(0, opfPath.lastIndexOf('/') + 1) + href;
            
            // Try to get chapter title from content
            try {
                const content = await zip.file(fullPath).async('string');
                const contentDoc = parser.parseFromString(content, 'text/html');
                
                // Try multiple selectors to find the chapter title
                let chapterTitle = '';
                let debugInfo = [];
                
                // Method 1: Try heading tags in body first (more compatible approach)
                const body = contentDoc.querySelector('body') || contentDoc;
                const bodyHeadings = body.querySelectorAll('h1, h2, h3, h4, h5, h6');
                if (bodyHeadings.length > 0) {
                    chapterTitle = bodyHeadings[0].textContent.trim();
                    debugInfo.push(`Found body heading: "${chapterTitle}"`);
                }
                
                // Method 2: If no body headings, try any headings (fallback for mobile)
                if (!chapterTitle) {
                    const allHeadings = contentDoc.querySelectorAll('h1, h2, h3, h4, h5, h6');
                    if (allHeadings.length > 0) {
                        chapterTitle = allHeadings[0].textContent.trim();
                        debugInfo.push(`Found any heading: "${chapterTitle}"`);
                    }
                }
                
                // Method 3: Try simple class-based selectors (mobile-friendly)
                if (!chapterTitle) {
                    const simpleSelectors = ['h1', 'h2', 'h3'];
                    for (const selector of simpleSelectors) {
                        const elements = contentDoc.getElementsByTagName(selector);
                        if (elements.length > 0) {
                            chapterTitle = elements[0].textContent.trim();
                            debugInfo.push(`Found ${selector}: "${chapterTitle}"`);
                            break;
                        }
                    }
                }
                
                // Method 4: Try elements with common chapter classes (simplified for mobile)
                if (!chapterTitle) {
                    const commonClasses = ['chapter-title', 'chapter-heading', 'title'];
                    for (const className of commonClasses) {
                        const elements = contentDoc.getElementsByClassName(className);
                        if (elements.length > 0 && elements[0].textContent.trim().length > 0) {
                            chapterTitle = elements[0].textContent.trim();
                            debugInfo.push(`Found class ${className}: "${chapterTitle}"`);
                            break;
                        }
                    }
                }
                
                // Method 5: Try bold elements (getElementsByTagName is more mobile-compatible)
                if (!chapterTitle) {
                    const boldTags = ['b', 'strong'];
                    for (const tag of boldTags) {
                        const elements = contentDoc.getElementsByTagName(tag);
                        for (let i = 0; i < elements.length; i++) {
                            const text = elements[i].textContent.trim();
                            if (text.length > 0 && text.length < 100 && !text.includes(' - ')) {
                                chapterTitle = text;
                                debugInfo.push(`Found ${tag}: "${chapterTitle}"`);
                                break;
                            }
                        }
                        if (chapterTitle) break;
                    }
                }
                
                // Method 6: Parse filename for chapter info
                if (!chapterTitle) {
                    const filename = fullPath.split('/').pop().replace(/\.(xhtml|html)$/, '');
                    if (filename.match(/chapter|ch\d+|part/i)) {
                        chapterTitle = filename.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                        debugInfo.push(`From filename: "${chapterTitle}"`);
                    }
                }
                
                // Method 7: Title tag as last resort with better filtering
                if (!chapterTitle) {
                    const titleElements = contentDoc.getElementsByTagName('title');
                    if (titleElements.length > 0) {
                        const titleText = titleElements[0].textContent.trim();
                        // Better filtering for mobile browsers
                        const skipPatterns = [' - ', ' by ', '|', ':', 'author'];
                        const shouldSkip = skipPatterns.some(pattern => 
                            titleText.toLowerCase().includes(pattern.toLowerCase())
                        );
                        
                        if (!shouldSkip && titleText.length < 100) {
                            chapterTitle = titleText;
                            debugInfo.push(`From title tag: "${chapterTitle}"`);
                        }
                    }
                }
                
                // Fallback to generic chapter name
                if (!chapterTitle || chapterTitle.length === 0) {
                    chapterTitle = `Chapter ${chapters.length + 1}`;
                    debugInfo.push(`Fallback: "${chapterTitle}"`);
                }
                
                // Clean up title (remove extra whitespace, limit length)
                chapterTitle = chapterTitle.replace(/\s+/g, ' ').trim();
                if (chapterTitle.length > 60) {
                    chapterTitle = chapterTitle.substring(0, 57) + '...';
                }
                
                // Log debug info for mobile troubleshooting
                console.log(`Chapter ${chapters.length + 1} extraction:`, debugInfo);
                
                chapters.push({
                    title: chapterTitle,
                    href: fullPath
                });
            } catch (e) {
                console.warn('Error processing chapter:', fullPath, e);
                chapters.push({
                    title: `Chapter ${chapters.length + 1}`,
                    href: fullPath
                });
            }
        }
    }
    
    return { title, chapters };
}

// Find OPF file path
async function findOpfPath(zip) {
    const containerXml = await zip.file('META-INF/container.xml').async('string');
    const parser = new DOMParser();
    const containerDoc = parser.parseFromString(containerXml, 'application/xml');
    const rootfile = containerDoc.querySelector('rootfile');
    return rootfile.getAttribute('full-path');
}

// Render books list
function renderBooksList(books) {
    booksList.innerHTML = '';
    books.forEach(book => {
        const li = document.createElement('li');
        li.className = 'book-item';
        
        // Add book type indicator and additional info
        const bookType = book.type || 'epub';
        const typeIndicator = bookType.toUpperCase();
        const additionalInfo = book.numPages ? ` (${book.numPages} pages)` : '';
        
        li.innerHTML = `
            <div class="book-info">
                <span class="book-title">${book.title}</span>
                <span class="book-meta">
                    <span class="book-type ${bookType}">${typeIndicator}</span>
                    ${additionalInfo}
                </span>
            </div>
            <div class="book-actions-list">
                <button class="btn btn-small" onclick="viewBook('${book.id}')">View Chapters</button>
                <button class="btn btn-small btn-danger" onclick="deleteBook('${book.id}')">Delete</button>
            </div>
        `;
        booksList.appendChild(li);
    });
}

// View book chapters
async function viewBook(bookId) {
    try {
        const book = await epubDB.getBook(bookId);
        
        if (!book) {
            alert('Book not found');
            return;
        }
        
        currentBook = book;
        showChaptersSection(book);
    } catch (error) {
        console.error('Error loading book:', error);
        alert('Error loading book');
    }
}

// Delete book
async function deleteBook(bookId) {
    if (!confirm('Are you sure you want to delete this book?')) {
        return;
    }
    
    try {
        await epubDB.deleteBook(bookId);
        await loadBooks();
        
        // Check if any books remain
        const remainingBooks = await epubDB.getAllBooks();
        if (remainingBooks.length === 0) {
            hideAllSections();
            uploadSection.style.display = 'block';
        }
    } catch (error) {
        console.error('Error deleting book:', error);
        alert('Error deleting book');
    }
}

// Show chapters section
function showChaptersSection(book) {
    hideAllSections();
    chaptersSection.style.display = 'block';
    bookTitle.textContent = book.title;
    
    chaptersList.innerHTML = '';
    
    if (!book.chapters || book.chapters.length === 0) {
        const li = document.createElement('li');
        li.className = 'chapter-item';
        li.innerHTML = '<span class="chapter-title">No chapters found</span>';
        chaptersList.appendChild(li);
        return;
    }
    
    book.chapters.forEach((chapter, index) => {
        const li = document.createElement('li');
        li.className = 'chapter-item';
        
        // Ensure chapter title is displayed properly
        const chapterTitle = chapter.title || `Chapter ${index + 1}`;
        
        li.innerHTML = `
            <span class="chapter-title">${escapeHtml(chapterTitle)}</span>
            <button class="btn btn-small" onclick="viewChapter('${book.id}', ${index})">View & Download</button>
        `;
        chaptersList.appendChild(li);
    });
}

// Helper function to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// View chapter content
async function viewChapter(bookId, chapterIndex) {
    // Show loading state immediately
    const chapterButtons = document.querySelectorAll('.chapter-item button');
    const clickedButton = chapterButtons[chapterIndex];
    if (clickedButton) {
        clickedButton.disabled = true;
        clickedButton.textContent = 'Loading...';
    }
    
    try {
        const book = await epubDB.getBook(bookId);
        
        if (!book) {
            alert('Book not found');
            return;
        }
        
        const chapter = book.chapters[chapterIndex];
        if (!chapter) {
            alert('Chapter not found');
            return;
        }
        
        // Load file and extract chapter content
        const fileBlob = await epubDB.getEpubFile(bookId);
        if (!fileBlob) {
            alert('File not found');
            return;
        }
        
        const arrayBuffer = await fileBlob.arrayBuffer();
        
        // Determine book type if not set (for backward compatibility)
        if (!book.type) {
            if (book.fileName) {
                if (book.fileName.toLowerCase().endsWith('.epub')) {
                    book.type = 'epub';
                } else if (book.fileName.toLowerCase().endsWith('.pdf')) {
                    book.type = 'pdf';
                }
            }
            console.warn('Book type was undefined, inferred as:', book.type);
        }
        
        console.log('File loaded, size:', arrayBuffer.byteLength, 'Type:', book.type);
        
        if (arrayBuffer.byteLength === 0) {
            throw new Error('File data is empty');
        }
        
        let textContent = ''; // Initialize to empty string instead of undefined
        
        if (book.type === 'epub') {
            console.log('Processing EPUB chapter...');
            try {
                // Handle EPUB
                const zip = await JSZip.loadAsync(arrayBuffer);
            
            // Check if the chapter file exists in the zip
            const chapterFile = zip.file(chapter.href);
            if (!chapterFile) {
                console.error('Chapter file not found in EPUB:', chapter.href);
                textContent = 'Error: Chapter file not found in EPUB archive';
            } else {
                console.log('Chapter file found, extracting content...');
                const content = await chapterFile.async('string');
                console.log('====== EPUB CHAPTER DEBUG ======');
                console.log('Chapter file:', chapter.href);
                console.log('Raw content length:', content.length);
                console.log('First 1000 chars of raw content:');
                console.log(content.substring(0, 1000));
                console.log('================================');
                
                // First, let's examine what we're dealing with
                console.log('Raw content type check:');
                console.log('- Starts with <?xml:', content.startsWith('<?xml'));
                console.log('- Contains <html:', content.includes('<html'));
                console.log('- Contains <body:', content.includes('<body'));
                console.log('- Contains namespace:', content.includes('xmlns'));
                
                const parser = new DOMParser();
                
                // Try multiple parsing approaches
                let doc;
                let parseSuccess = false;
                
                // Method 1: Try as XHTML
                try {
                    doc = parser.parseFromString(content, 'application/xhtml+xml');
                    if (doc.documentElement.tagName !== 'parsererror') {
                        console.log('Successfully parsed as XHTML');
                        parseSuccess = true;
                    }
                } catch (e) {
                    console.log('XHTML parsing failed:', e.message);
                }
                
                // Method 2: Try as HTML
                if (!parseSuccess) {
                    try {
                        doc = parser.parseFromString(content, 'text/html');
                        console.log('Parsed as HTML');
                        parseSuccess = true;
                    } catch (e) {
                        console.log('HTML parsing failed:', e.message);
                    }
                }
                
                // Method 3: If all else fails, create a wrapper
                if (!parseSuccess) {
                    console.warn('Standard parsing failed, trying wrapper approach');
                    const wrappedContent = `<!DOCTYPE html><html><body>${content}</body></html>`;
                    doc = parser.parseFromString(wrappedContent, 'text/html');
                }
                
                // Get the body element, trying multiple selectors
                let rootElement = doc.body || 
                                 doc.querySelector('body') || 
                                 doc.querySelector('html') ||
                                 doc.documentElement;
                
                if (!rootElement) {
                    console.error('No root element found in chapter HTML');
                    console.log('Document structure:', doc);
                    textContent = 'Error: Could not extract text from chapter';
                } else {
                    console.log('Root element found:', rootElement.tagName);
                    
                    // First, let's see what we're working with
                    console.log('Root element:', rootElement);
                    console.log('Root element tagName:', rootElement.tagName);
                    console.log('Root element children count:', rootElement.children ? rootElement.children.length : 0);
                    
                    // Method 1: Try innerText (most reliable for displayed text)
                    if (rootElement.innerText !== undefined) {
                        textContent = rootElement.innerText;
                        console.log('innerText length:', textContent.length);
                    }
                    
                    // Method 2: Try textContent
                    if (!textContent || textContent.length === 0) {
                        textContent = rootElement.textContent || '';
                        console.log('textContent length:', textContent.length);
                    }
                    
                    // Method 3: If DOM methods fail, try namespace-aware extraction
                    if (!textContent || textContent.length === 0) {
                        console.warn('DOM extraction failed, checking for namespaced elements');
                        
                        // Try to get all elements regardless of namespace
                        const allElements = doc.getElementsByTagName('*');
                        console.log('Total elements in document:', allElements.length);
                        
                        // Extract text from all elements
                        const texts = [];
                        for (let i = 0; i < allElements.length; i++) {
                            const elem = allElements[i];
                            // Skip script and style elements
                            const tagName = elem.tagName.toLowerCase();
                            if (tagName === 'script' || tagName === 'style') continue;
                            
                            // Get direct text content (not from children)
                            for (let j = 0; j < elem.childNodes.length; j++) {
                                const node = elem.childNodes[j];
                                if (node.nodeType === 3) { // Text node
                                    const text = node.nodeValue.trim();
                                    if (text) texts.push(text);
                                }
                            }
                        }
                        
                        if (texts.length > 0) {
                            textContent = texts.join(' ');
                            console.log('Namespace-aware extraction found', texts.length, 'text pieces');
                        }
                    }
                    
                    // Method 4: Regex extraction from raw content
                    if (!textContent || textContent.length === 0) {
                        console.warn('Namespace extraction failed, trying regex extraction from raw content');
                        
                        // Remove scripts and styles
                        let cleanContent = content;
                        cleanContent = cleanContent.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
                        cleanContent = cleanContent.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
                        
                        // Extract text between tags (improved regex)
                        const textMatches = cleanContent.match(/>([^<]+)</g);
                        if (textMatches) {
                            textContent = textMatches
                                .map(match => match.substring(1, match.length - 1))
                                .filter(text => text.trim().length > 0)
                                .join(' ')
                                .replace(/\s+/g, ' ')
                                .trim();
                            console.log('Regex extraction found', textMatches.length, 'matches, final length:', textContent.length);
                        }
                    }
                    
                    // Clean up the text
                    if (textContent.length > 0) {
                        textContent = textContent.replace(/\s+/g, ' ').trim();
                        console.log('Final cleaned text length:', textContent.length);
                        console.log('Text preview:', textContent.substring(0, 200));
                    }
                    
                    // Method 3: Try getting all paragraph and heading elements
                    if (!textContent || textContent.length === 0) {
                        console.warn('No text from textContent, trying to extract from paragraphs and headings');
                        const textElements = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div, span, li, td, th, blockquote');
                        const textParts = [];
                        textElements.forEach(el => {
                            const text = (el.textContent || '').trim();
                            if (text) {
                                textParts.push(text);
                            }
                        });
                        textContent = textParts.join('\n\n');
                    }
                    
                    // Method 4: Last resort - innerHTML fallback
                    if (!textContent || textContent.length === 0) {
                        console.warn('Still no text, trying innerHTML text extraction');
                        // Get innerHTML and strip tags
                        let html = rootElement.innerHTML || '';
                        // Remove script and style content
                        html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
                        html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
                        // Replace tags with spaces
                        html = html.replace(/<br\s*\/?>/gi, '\n');
                        html = html.replace(/<\/p>/gi, '\n\n');
                        html = html.replace(/<\/div>/gi, '\n');
                        html = html.replace(/<[^>]+>/g, ' ');
                        // Decode HTML entities
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = html;
                        textContent = tempDiv.textContent || tempDiv.innerText || '';
                        textContent = textContent.replace(/\s+/g, ' ').trim();
                    }
                    
                    // Final check to ensure we have content
                    if (!textContent || textContent.length === 0) {
                        console.error('Still no text content after all extraction attempts');
                        console.log('Document HTML preview:', doc.documentElement.innerHTML.substring(0, 1000));
                        
                        // Ultimate fallback: strip ALL tags from the original content
                        console.warn('Using ultimate fallback: stripping all tags from raw content');
                        textContent = content
                            .replace(/<!--[\s\S]*?-->/g, '') // Remove comments
                            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove scripts
                            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // Remove styles
                            .replace(/<[^>]+>/g, ' ') // Remove all tags
                            .replace(/&nbsp;/g, ' ') // Replace nbsp
                            .replace(/&[^;]+;/g, ' ') // Remove other entities
                            .replace(/\s+/g, ' ') // Normalize whitespace
                            .trim();
                        
                        if (textContent.length > 0) {
                            console.log('Ultimate fallback found text, length:', textContent.length);
                        } else {
                            textContent = 'Error: No text content could be extracted from this chapter. The chapter file may be empty, corrupted, or use an unsupported format.';
                        }
                    }
                }
                
                console.log('EPUB text extraction - Chapter:', chapter.title, 'Text length:', textContent.length);
                
                // EMERGENCY FALLBACK: If still no text, just use the raw content
                if (!textContent || textContent.length === 0) {
                    console.error('EMERGENCY: All extraction methods failed!');
                    console.log('Using raw content as last resort');
                    
                    // Just strip the most basic tags and use whatever's left
                    textContent = content
                        .replace(/<[^>]*>/g, ' ') // Remove ALL tags
                        .replace(/\s+/g, ' ') // Collapse whitespace
                        .trim();
                    
                    if (textContent.length === 0) {
                        // If STILL nothing, the file might be truly empty
                        textContent = `[Debug Info]\nFile: ${chapter.href}\nRaw content length: ${content.length}\nFirst 500 chars: ${content.substring(0, 500)}`;
                    }
                }
            }
            } catch (epubError) {
                console.error('Error processing EPUB chapter:', epubError);
                textContent = `Error processing EPUB: ${epubError.message}`;
            }
            
        } else if (book.type === 'pdf') {
            // Handle PDF
            textContent = await PDFParser.extractTextFromPDFRange(
                arrayBuffer, 
                chapter.startPage, 
                chapter.endPage
            );
        } else {
            console.error('Unknown book type:', book.type);
            textContent = 'Error: Unknown book type';
        }
        
        // Ensure we're setting the content properly
        console.log('=== FINAL CONTENT CHECK ===');
        console.log('Book type:', book.type);
        console.log('textContent type:', typeof textContent);
        console.log('textContent value:', textContent);
        console.log('textContent length:', textContent ? textContent.length : 'null/undefined');
        
        if (textContent && textContent.length > 0) {
            currentChapterContent = textContent;
            console.log('SUCCESS: Set currentChapterContent, length:', currentChapterContent.length);
            console.log('First 200 chars:', currentChapterContent.substring(0, 200));
        } else {
            console.error('ERROR: textContent is empty or undefined');
            console.error('Setting error message as content');
            currentChapterContent = 'Error: No content could be extracted from this chapter. Check console for debug info.';
        }
        
        // Show content
        hideAllSections();
        contentSection.style.display = 'block';
        chapterTitle.textContent = chapter.title;
        
        // Make sure the content element exists and update it
        if (chapterContent) {
            chapterContent.textContent = currentChapterContent;
            console.log('Updated DOM element with content, element text length:', chapterContent.textContent.length);
            
            // Double-check the element was updated
            if (chapterContent.textContent.length === 0) {
                console.error('WARNING: DOM element text is empty after update!');
                chapterContent.innerHTML = `<pre>${currentChapterContent}</pre>`;
            }
        } else {
            console.error('ERROR: chapterContent DOM element not found!');
        }
        
    } catch (error) {
        console.error('Error loading chapter:', error);
        alert('Error loading chapter content');
    } finally {
        // Reset button state
        if (clickedButton) {
            clickedButton.disabled = false;
            clickedButton.textContent = 'View & Download';
        }
    }
}

// Extract text from HTML
function extractTextFromHtml(element) {
    if (!element) {
        console.error('extractTextFromHtml: element is null or undefined');
        return '';
    }
    
    console.log('Starting text extraction from element:', element.tagName || 'unknown');
    
    let text = '';
    let nodeCount = 0;
    let textNodeCount = 0;
    
    function traverse(node) {
        if (!node) return;
        
        nodeCount++;
        
        if (node.nodeType === Node.TEXT_NODE) {
            const nodeText = node.textContent || '';
            // Add all text, even whitespace (we'll clean it up later)
            if (nodeText) {
                text += nodeText;
                textNodeCount++;
            }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            // Skip style and script elements
            const skipElements = ['style', 'script', 'noscript'];
            const tagName = node.tagName ? node.tagName.toLowerCase() : '';
            
            if (skipElements.includes(tagName)) {
                return;
            }
            
            // Add line breaks for block elements BEFORE processing children
            const blockElements = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'li', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'blockquote', 'pre', 'td', 'th'];
            
            if (blockElements.includes(tagName) && text.length > 0) {
                text += '\n';
            }
            
            // Process child nodes
            if (node.childNodes && node.childNodes.length > 0) {
                for (let i = 0; i < node.childNodes.length; i++) {
                    traverse(node.childNodes[i]);
                }
            }
            
            // Add line break after block element
            if (blockElements.includes(tagName) && text.length > 0) {
                text += '\n';
            }
            
            // Add space after inline elements that typically need spacing
            const spaceAfterElements = ['span', 'a', 'em', 'strong', 'b', 'i', 'u'];
            if (spaceAfterElements.includes(tagName) && text.length > 0 && !text.endsWith(' ')) {
                text += ' ';
            }
        }
    }
    
    traverse(element);
    
    console.log(`Text extraction complete. Processed ${nodeCount} nodes, found ${textNodeCount} text nodes`);
    console.log('Raw text length:', text.length);
    
    // Clean up whitespace more carefully
    text = text.replace(/\r\n/g, '\n'); // Normalize line endings
    text = text.replace(/\n{3,}/g, '\n\n'); // Reduce multiple line breaks to double
    text = text.replace(/[ \t]+/g, ' '); // Reduce multiple spaces/tabs to single space
    text = text.replace(/\n[ \t]+/g, '\n'); // Remove leading spaces on lines
    text = text.replace(/[ \t]+\n/g, '\n'); // Remove trailing spaces on lines
    text = text.trim();
    
    console.log('Cleaned text length:', text.length);
    if (text.length > 0) {
        console.log('First 200 chars of extracted text:', text.substring(0, 200));
    }
    
    return text;
}

// Download chapter as .txt
function downloadChapter() {
    // Check if we have content to download
    if (!currentChapterContent) {
        console.error('No chapter content to download');
        alert('No chapter content available to download');
        return;
    }
    
    const fileName = `${chapterTitle.textContent.replace(/[^a-z0-9]/gi, '_')}.txt`;
    const blob = new Blob([currentChapterContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Show loading indicator
function showLoadingIndicator(totalChapters) {
    loadingIndicator.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = `0 / ${totalChapters} chapters`;
    downloadFullBookBtn.disabled = true;
    downloadFullBookBtn.textContent = 'Processing...';
}

// Update loading progress
function updateLoadingProgress(current, total) {
    const percentage = (current / total) * 100;
    progressFill.style.width = `${percentage}%`;
    progressText.textContent = `${current} / ${total} chapters`;
}

// Hide loading indicator
function hideLoadingIndicator() {
    loadingIndicator.style.display = 'none';
    downloadFullBookBtn.disabled = false;
    downloadFullBookBtn.textContent = 'Download Full Book as .txt';
}

// Download entire book as .txt
async function downloadFullBook() {
    if (!currentBook) {
        alert('No book selected');
        return;
    }
    
    const totalChapters = currentBook.chapters.length;
    showLoadingIndicator(totalChapters);
    
    try {
        // Load file
        const fileBlob = await epubDB.getEpubFile(currentBook.id);
        if (!fileBlob) {
            alert('File not found');
            return;
        }
        
        const arrayBuffer = await fileBlob.arrayBuffer();
        
        console.log('Full book download - File loaded, size:', arrayBuffer.byteLength);
        
        if (arrayBuffer.byteLength === 0) {
            throw new Error('File data is empty');
        }
        
        // Determine book type if not set (for backward compatibility)
        if (!currentBook.type) {
            if (currentBook.fileName) {
                if (currentBook.fileName.toLowerCase().endsWith('.epub')) {
                    currentBook.type = 'epub';
                } else if (currentBook.fileName.toLowerCase().endsWith('.pdf')) {
                    currentBook.type = 'pdf';
                }
            }
            console.warn('Book type was undefined, inferred as:', currentBook.type);
        }
        
        // Extract all chapter content
        let fullBookText = '';
        fullBookText += `${currentBook.title}\n`;
        fullBookText += '='.repeat(currentBook.title.length) + '\n\n';
        
        if (currentBook.type === 'pdf') {
            fullBookText += `PDF Document (${currentBook.numPages} pages)\n\n`;
        }
        
        for (let i = 0; i < currentBook.chapters.length; i++) {
            const chapter = currentBook.chapters[i];
            
            // Update progress
            updateLoadingProgress(i, totalChapters);
            
            try {
                let textContent;
                
                if (currentBook.type === 'epub') {
                    // Handle EPUB
                    const zip = await JSZip.loadAsync(arrayBuffer);
                    
                    // Check if the chapter file exists in the zip
                    const chapterFile = zip.file(chapter.href);
                    if (!chapterFile) {
                        console.error('Chapter file not found in EPUB:', chapter.href);
                        textContent = '[Error: Chapter file not found in EPUB archive]';
                    } else {
                        const content = await chapterFile.async('string');
                        const parser = new DOMParser();
                        
                        // Try parsing as XHTML first (common in EPUB), then fall back to HTML
                        let doc;
                        try {
                            doc = parser.parseFromString(content, 'application/xhtml+xml');
                        } catch (e) {
                            doc = parser.parseFromString(content, 'text/html');
                        }
                        
                        // Get the body element, or fall back to the document element
                        const rootElement = doc.body || doc.querySelector('body') || doc.documentElement;
                        
                        if (!rootElement) {
                            console.error('No root element found in chapter HTML for:', chapter.title);
                            textContent = '[Error: Could not extract text from chapter]';
                        } else {
                            textContent = extractTextFromHtml(rootElement);
                            
                            // If no text was extracted, try alternative approach
                            if (!textContent || textContent.length === 0) {
                                console.warn('No text extracted for chapter:', chapter.title);
                                // Try getting all text content directly
                                textContent = rootElement.textContent || rootElement.innerText || '';
                                textContent = textContent.replace(/\s+/g, ' ').trim();
                            }
                        }
                    }
                    
                } else if (currentBook.type === 'pdf') {
                    // Handle PDF
                    textContent = await PDFParser.extractTextFromPDFRange(
                        arrayBuffer, 
                        chapter.startPage, 
                        chapter.endPage
                    );
                }
                
                // Add chapter to full text
                fullBookText += `\n\n--- ${chapter.title} ---\n\n`;
                fullBookText += textContent;
                
                // Add some spacing between chapters
                if (i < currentBook.chapters.length - 1) {
                    fullBookText += '\n\n';
                }
                
            } catch (error) {
                console.warn('Error processing chapter:', chapter, error);
                fullBookText += `\n\n--- ${chapter.title} ---\n\n`;
                fullBookText += '[Error loading chapter content]';
            }
            
            // Allow UI to update between chapters (important for mobile)
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        // Final progress update
        updateLoadingProgress(totalChapters, totalChapters);
        
        // Create and download file
        const fileName = `${currentBook.title.replace(/[^a-z0-9]/gi, '_')}_complete.txt`;
        const blob = new Blob([fullBookText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
    } catch (error) {
        console.error('Error downloading full book:', error);
        alert('Error downloading full book');
    } finally {
        hideLoadingIndicator();
    }
}

// Show books section
function showBooksSection() {
    hideAllSections();
    uploadSection.style.display = 'block';
    booksSection.style.display = 'block';
}

// Hide all sections
function hideAllSections() {
    uploadSection.style.display = 'none';
    booksSection.style.display = 'none';
    chaptersSection.style.display = 'none';
    contentSection.style.display = 'none';
}

// Make functions globally accessible
window.viewBook = viewBook;
window.deleteBook = deleteBook;
window.viewChapter = viewChapter;