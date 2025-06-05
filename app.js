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
    if (!file || !file.name.endsWith('.epub')) {
        alert('Please select a valid EPUB file');
        return;
    }
    
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Processing...';
    
    try {
        const arrayBuffer = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(arrayBuffer);
        
        // Parse EPUB structure (metadata only for now)
        const epubData = await parseEpubStructure(zip);
        
        // Create book object with metadata
        const book = {
            id: Date.now().toString(),
            title: epubData.title || file.name.replace('.epub', ''),
            fileName: file.name,
            chapters: epubData.chapters,
            uploadDate: new Date().toISOString(),
            fileSize: file.size
        };
        
        // Create blob from the EPUB file
        const epubBlob = new Blob([arrayBuffer], { type: 'application/epub+zip' });
        
        // Save to IndexedDB
        await epubDB.addBook(book, epubBlob);
        
        // Clear file input and refresh books list
        fileInput.value = '';
        await loadBooks();
        
    } catch (error) {
        console.error('Error processing EPUB:', error);
        if (error.name === 'QuotaExceededError') {
            alert('Storage quota exceeded. Please delete some books or try a smaller EPUB file.');
        } else {
            alert('Error processing EPUB file. Please try another file.');
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
        li.innerHTML = `
            <span class="book-title">${book.title}</span>
            <button class="btn btn-small" onclick="viewBook('${book.id}')">View Chapters</button>
            <button class="btn btn-small btn-danger" onclick="deleteBook('${book.id}')">Delete</button>
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
        
        // Load EPUB file and extract chapter content
        const epubBlob = await epubDB.getEpubFile(bookId);
        if (!epubBlob) {
            alert('EPUB file not found');
            return;
        }
        
        const arrayBuffer = await epubBlob.arrayBuffer();
        const zip = await JSZip.loadAsync(arrayBuffer);
        
        // Get chapter content
        const content = await zip.file(chapter.href).async('string');
        const parser = new DOMParser();
        const doc = parser.parseFromString(content, 'text/html');
        
        // Extract text content
        const textContent = extractTextFromHtml(doc.body);
        
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
        // Load EPUB file
        const epubBlob = await epubDB.getEpubFile(currentBook.id);
        if (!epubBlob) {
            alert('EPUB file not found');
            return;
        }
        
        const arrayBuffer = await epubBlob.arrayBuffer();
        const zip = await JSZip.loadAsync(arrayBuffer);
        
        // Extract all chapter content
        let fullBookText = '';
        fullBookText += `${currentBook.title}\n`;
        fullBookText += '='.repeat(currentBook.title.length) + '\n\n';
        
        for (let i = 0; i < currentBook.chapters.length; i++) {
            const chapter = currentBook.chapters[i];
            
            // Update progress
            updateLoadingProgress(i, totalChapters);
            
            try {
                // Get chapter content
                const content = await zip.file(chapter.href).async('string');
                const parser = new DOMParser();
                const doc = parser.parseFromString(content, 'text/html');
                
                // Extract text content
                const textContent = extractTextFromHtml(doc.body);
                
                // Add chapter to full text
                fullBookText += `\n\n--- ${chapter.title} ---\n\n`;
                fullBookText += textContent;
                
                // Add some spacing between chapters
                if (i < currentBook.chapters.length - 1) {
                    fullBookText += '\n\n';
                }
                
            } catch (error) {
                console.warn('Error processing chapter:', chapter.href, error);
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