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
                            pageNum: pageNum
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
            
            // Create chapter objects with proper page ranges
            for (let i = 0; i < mainChapters.length; i++) {
                const entry = mainChapters[i];
                const nextEntry = mainChapters[i + 1];
                
                chapters.push({
                    title: entry.title,
                    startPage: entry.pageNum,
                    endPage: nextEntry ? nextEntry.pageNum - 1 : numPages,
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
        
        console.log('File loaded, size:', arrayBuffer.byteLength, 'Type:', book.type);
        
        if (arrayBuffer.byteLength === 0) {
            throw new Error('File data is empty');
        }
        
        let textContent;
        
        if (book.type === 'epub') {
            // Handle EPUB
            const zip = await JSZip.loadAsync(arrayBuffer);
            const content = await zip.file(chapter.href).async('string');
            const parser = new DOMParser();
            const doc = parser.parseFromString(content, 'text/html');
            textContent = extractTextFromHtml(doc.body);
            
        } else if (book.type === 'pdf') {
            // Handle PDF
            textContent = await PDFParser.extractTextFromPDFRange(
                arrayBuffer, 
                chapter.startPage, 
                chapter.endPage
            );
        }
        
        currentChapterContent = textContent;
        
        // Show content
        hideAllSections();
        contentSection.style.display = 'block';
        chapterTitle.textContent = chapter.title;
        chapterContent.textContent = textContent;
        
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
    let text = '';
    
    function traverse(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            // Add line breaks for block elements
            const blockElements = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'li'];
            if (blockElements.includes(node.tagName.toLowerCase())) {
                text += '\n';
            }
            
            for (const child of node.childNodes) {
                traverse(child);
            }
            
            if (blockElements.includes(node.tagName.toLowerCase())) {
                text += '\n';
            }
        }
    }
    
    traverse(element);
    
    // Clean up excessive line breaks
    return text.replace(/\n{3,}/g, '\n\n').trim();
}

// Download chapter as .txt
function downloadChapter() {
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
                    const content = await zip.file(chapter.href).async('string');
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(content, 'text/html');
                    textContent = extractTextFromHtml(doc.body);
                    
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