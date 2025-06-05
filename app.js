// State management
let currentBook = null;
let currentChapterContent = '';

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
const backToBooks = document.getElementById('back-to-books');
const backToChapters = document.getElementById('back-to-chapters');

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    loadBooks();
    
    uploadBtn.addEventListener('click', handleUpload);
    backToBooks.addEventListener('click', showBooksSection);
    backToChapters.addEventListener('click', () => showChaptersSection(currentBook));
    downloadBtn.addEventListener('click', downloadChapter);
});

// Load books from localStorage
function loadBooks() {
    const books = getStoredBooks();
    if (books.length > 0) {
        showBooksSection();
        renderBooksList(books);
    }
}

// Get stored books from localStorage
function getStoredBooks() {
    const booksJson = localStorage.getItem('epubBooks');
    return booksJson ? JSON.parse(booksJson) : [];
}

// Save books to localStorage
function saveBooks(books) {
    localStorage.setItem('epubBooks', JSON.stringify(books));
}

// Handle file upload
async function handleUpload() {
    const file = fileInput.files[0];
    if (!file || !file.name.endsWith('.epub')) {
        alert('Please select a valid EPUB file');
        return;
    }
    
    try {
        const arrayBuffer = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(arrayBuffer);
        
        // Parse EPUB structure and extract all chapter content
        const epubData = await parseEpubWithContent(zip);
        
        // Create book object
        const book = {
            id: Date.now().toString(),
            title: epubData.title || file.name.replace('.epub', ''),
            fileName: file.name,
            chapters: epubData.chapters
        };
        
        // Save to localStorage (only the parsed data, not the original EPUB)
        const books = getStoredBooks();
        books.push(book);
        saveBooks(books);
        
        // Clear file input and show books
        fileInput.value = '';
        showBooksSection();
        renderBooksList(books);
        
    } catch (error) {
        console.error('Error processing EPUB:', error);
        if (error.name === 'QuotaExceededError') {
            alert('Storage quota exceeded. Please delete some books or try a smaller EPUB file.');
        } else {
            alert('Error processing EPUB file. Please try another file.');
        }
    }
}

// Parse EPUB structure with content extraction
async function parseEpubWithContent(zip) {
    const opfPath = await findOpfPath(zip);
    const opfContent = await zip.file(opfPath).async('string');
    const parser = new DOMParser();
    const opfDoc = parser.parseFromString(opfContent, 'application/xml');
    
    // Get title
    const titleElement = opfDoc.querySelector('metadata title');
    const title = titleElement ? titleElement.textContent : 'Unknown Title';
    
    // Get spine items (reading order)
    const spine = opfDoc.querySelector('spine');
    const itemrefs = spine ? Array.from(spine.querySelectorAll('itemref')) : [];
    
    // Get manifest items
    const manifest = opfDoc.querySelector('manifest');
    const items = manifest ? Array.from(manifest.querySelectorAll('item')) : [];
    
    // Build chapters array with extracted content
    const chapters = [];
    for (const itemref of itemrefs) {
        const idref = itemref.getAttribute('idref');
        const item = items.find(i => i.getAttribute('id') === idref);
        
        if (item && item.getAttribute('media-type') === 'application/xhtml+xml') {
            const href = item.getAttribute('href');
            const fullPath = opfPath.substring(0, opfPath.lastIndexOf('/') + 1) + href;
            
            // Extract chapter title and content
            try {
                const content = await zip.file(fullPath).async('string');
                const contentDoc = parser.parseFromString(content, 'text/html');
                const h1 = contentDoc.querySelector('h1, h2, h3, title');
                const chapterTitle = h1 ? h1.textContent.trim() : `Chapter ${chapters.length + 1}`;
                
                // Extract text content immediately
                const textContent = extractTextFromHtml(contentDoc.body);
                
                chapters.push({
                    title: chapterTitle,
                    content: textContent
                });
            } catch (e) {
                console.warn('Error processing chapter:', fullPath, e);
                chapters.push({
                    title: `Chapter ${chapters.length + 1}`,
                    content: 'Error loading chapter content.'
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
    const books = getStoredBooks();
    const book = books.find(b => b.id === bookId);
    
    if (!book) {
        alert('Book not found');
        return;
    }
    
    currentBook = book;
    showChaptersSection(book);
}

// Delete book
function deleteBook(bookId) {
    if (!confirm('Are you sure you want to delete this book?')) {
        return;
    }
    
    const books = getStoredBooks();
    const filteredBooks = books.filter(b => b.id !== bookId);
    saveBooks(filteredBooks);
    
    // Remove EPUB data
    localStorage.removeItem(`epub_${bookId}`);
    
    renderBooksList(filteredBooks);
    
    if (filteredBooks.length === 0) {
        hideAllSections();
        uploadSection.style.display = 'block';
    }
}

// Show chapters section
function showChaptersSection(book) {
    hideAllSections();
    chaptersSection.style.display = 'block';
    bookTitle.textContent = book.title;
    
    chaptersList.innerHTML = '';
    book.chapters.forEach((chapter, index) => {
        const li = document.createElement('li');
        li.className = 'chapter-item';
        li.innerHTML = `
            <span class="chapter-title">${chapter.title}</span>
            <button class="btn btn-small" onclick="viewChapter('${book.id}', ${index})">View & Download</button>
        `;
        chaptersList.appendChild(li);
    });
}

// View chapter content
function viewChapter(bookId, chapterIndex) {
    const books = getStoredBooks();
    const book = books.find(b => b.id === bookId);
    
    if (!book) {
        alert('Book not found');
        return;
    }
    
    const chapter = book.chapters[chapterIndex];
    if (!chapter) {
        alert('Chapter not found');
        return;
    }
    
    // Content is already extracted and stored
    currentChapterContent = chapter.content;
    
    // Show content
    hideAllSections();
    contentSection.style.display = 'block';
    chapterTitle.textContent = chapter.title;
    chapterContent.textContent = chapter.content;
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