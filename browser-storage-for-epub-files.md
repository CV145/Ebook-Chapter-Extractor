# Browser Storage Alternatives for EPUB Files (1-50MB)

## 1. IndexedDB

### Storage Capacity Limits
- **Chrome/Chromium**: 60% of available disk space per origin (can be 100+ GB)
- **Firefox**: 10% of disk space or 10GB (whichever is smaller), up to 50% for persistent storage
- **Safari**: No fixed limit, prompts user for permission when needed
- **Edge**: Same as Chrome (60% of disk space)

### Browser Support
- Universal support across all modern browsers
- IE 10+ supported (with 250MB limit)

### Implementation Complexity
- Medium complexity - requires understanding of asynchronous operations and transactions
- Well-documented API with good tooling support

### Pros
- Native support for binary data (Blobs, ArrayBuffers)
- No file size limit per item
- Excellent for structured data with indexing
- Persistent storage available
- Good performance for read/write operations

### Cons
- Asynchronous API can be complex
- Subject to browser storage quotas
- Data can be evicted in best-effort mode

### Code Example
```javascript
// Open database
const openDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('EPUBLibrary', 1);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('epubs')) {
        db.createObjectStore('epubs', { keyPath: 'id' });
      }
    };
  });
};

// Store EPUB file
const storeEPUB = async (id, epubBlob, metadata) => {
  const db = await openDB();
  const transaction = db.transaction(['epubs'], 'readwrite');
  const store = transaction.objectStore('epubs');
  
  return store.put({
    id: id,
    file: epubBlob,
    metadata: metadata,
    timestamp: Date.now()
  });
};

// Retrieve EPUB file
const getEPUB = async (id) => {
  const db = await openDB();
  const transaction = db.transaction(['epubs'], 'readonly');
  const store = transaction.objectStore('epubs');
  
  return new Promise((resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

// Check available storage
const checkStorage = async () => {
  if ('storage' in navigator && 'estimate' in navigator.storage) {
    const {usage, quota} = await navigator.storage.estimate();
    console.log(`Using ${usage} out of ${quota} bytes.`);
    return {usage, quota};
  }
};
```

## 2. File System Access API

### Storage Capacity Limits
- **OPFS**: Subject to same quota as IndexedDB
- **Local File System**: Limited only by device storage

### Browser Support
- **Chrome/Edge**: Full support (v86+)
- **Safari**: OPFS only (no local file access)
- **Firefox**: Not supported

### Implementation Complexity
- Low for basic operations
- High for cross-browser compatibility

### Pros
- Direct file system access (Chrome/Edge)
- High performance with synchronous operations in workers
- Byte-level file access
- No serialization overhead

### Cons
- Limited browser support
- Requires user permission for local files
- OPFS files not visible to user

### Code Example (OPFS)
```javascript
// Store EPUB in OPFS
const storeEPUBInOPFS = async (filename, epubBlob) => {
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(epubBlob);
  await writable.close();
};

// Read EPUB from OPFS
const getEPUBFromOPFS = async (filename) => {
  try {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(filename);
    return await fileHandle.getFile();
  } catch (error) {
    console.error('File not found:', error);
    return null;
  }
};

// Worker-based synchronous access (faster)
// In a Web Worker:
const syncFileAccess = async (filename) => {
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(filename);
  const accessHandle = await fileHandle.createSyncAccessHandle();
  
  // Get file size
  const fileSize = accessHandle.getSize();
  
  // Read file
  const buffer = new ArrayBuffer(fileSize);
  accessHandle.read(buffer, { at: 0 });
  
  // Don't forget to close
  accessHandle.close();
  
  return buffer;
};
```

## 3. Cache API

### Storage Capacity Limits
- Shares quota with other storage APIs
- **Desktop**: Typically 20GB+ available
- **Mobile**: 50MB-100MB typical, varies by device

### Browser Support
- All modern browsers with Service Worker support
- Not available in Safari Private Browsing

### Implementation Complexity
- Low - simple key-value storage
- Requires Service Worker for full functionality

### Pros
- Simple API
- Good for network resources
- Automatic with Service Workers
- Can store Response objects directly

### Cons
- Designed for HTTP responses, not files
- Subject to cache eviction
- Requires wrapping files as Response objects

### Code Example
```javascript
// Store EPUB in Cache API
const storeEPUBInCache = async (url, epubBlob) => {
  const cache = await caches.open('epub-library-v1');
  const response = new Response(epubBlob, {
    headers: {
      'Content-Type': 'application/epub+zip',
      'Content-Length': epubBlob.size
    }
  });
  await cache.put(url, response);
};

// Retrieve EPUB from Cache
const getEPUBFromCache = async (url) => {
  const cache = await caches.open('epub-library-v1');
  const response = await cache.match(url);
  if (response) {
    return await response.blob();
  }
  return null;
};

// Check cache storage
const checkCacheStorage = async () => {
  if ('storage' in navigator && 'estimate' in navigator.storage) {
    const {usage, quota} = await navigator.storage.estimate();
    const percentUsed = (usage / quota * 100).toFixed(2);
    console.log(`Cache using ${percentUsed}% of available storage`);
  }
};
```

## 4. WebSQL (Deprecated)

**Not Recommended** - Removed from browsers as of 2024. Mentioned only for completeness.

## 5. Modern Hybrid Solutions

### SQLite WASM with OPFS

Combines SQLite database with OPFS for persistent storage.

#### Pros
- Full SQL database capabilities
- Efficient binary storage
- Good performance with OPFS backing

#### Cons
- Requires loading SQLite WASM (~1MB)
- Complex setup
- Limited to browsers with OPFS support

### Example Setup
```javascript
// Using SQLite WASM with OPFS
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const initSQLite = async () => {
  const sqlite3 = await sqlite3InitModule({
    print: console.log,
    printErr: console.error,
  });
  
  const db = new sqlite3.oo1.DB('epub-library.db', 'opfs');
  
  // Create table for EPUBs
  db.exec(`
    CREATE TABLE IF NOT EXISTS epubs (
      id INTEGER PRIMARY KEY,
      filename TEXT NOT NULL,
      data BLOB NOT NULL,
      size INTEGER,
      added_date TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  return db;
};

// Store EPUB
const storeEPUBInSQLite = async (db, filename, arrayBuffer) => {
  const stmt = db.prepare(
    'INSERT INTO epubs (filename, data, size) VALUES (?, ?, ?)'
  );
  stmt.bind([filename, arrayBuffer, arrayBuffer.byteLength]);
  stmt.step();
  stmt.finalize();
};
```

## Recommendations for EPUB Storage

### Best Overall Solution: IndexedDB
- Universal browser support
- Native binary data handling
- Large storage quotas
- Well-tested and documented

### For Performance-Critical Apps: OPFS
- 3-4x faster than IndexedDB
- Ideal for frequent read/write operations
- Use with fallback to IndexedDB for Firefox

### Implementation Strategy
```javascript
// Feature detection and fallback strategy
class EPUBStorage {
  constructor() {
    this.storageType = this.detectBestStorage();
  }
  
  detectBestStorage() {
    if ('storage' in navigator && 'getDirectory' in navigator.storage) {
      return 'opfs';
    } else if ('indexedDB' in window) {
      return 'indexeddb';
    } else if ('caches' in window) {
      return 'cache';
    }
    throw new Error('No suitable storage API available');
  }
  
  async store(id, epubBlob, metadata) {
    switch (this.storageType) {
      case 'opfs':
        return this.storeInOPFS(id, epubBlob, metadata);
      case 'indexeddb':
        return this.storeInIndexedDB(id, epubBlob, metadata);
      case 'cache':
        return this.storeInCache(id, epubBlob, metadata);
    }
  }
  
  async retrieve(id) {
    switch (this.storageType) {
      case 'opfs':
        return this.retrieveFromOPFS(id);
      case 'indexeddb':
        return this.retrieveFromIndexedDB(id);
      case 'cache':
        return this.retrieveFromCache(id);
    }
  }
  
  async checkQuota() {
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const {usage, quota} = await navigator.storage.estimate();
      const available = quota - usage;
      return {
        usage,
        quota,
        available,
        percentUsed: (usage / quota * 100).toFixed(2)
      };
    }
    return null;
  }
  
  async requestPersistence() {
    if ('storage' in navigator && 'persist' in navigator.storage) {
      const isPersisted = await navigator.storage.persist();
      console.log(`Persisted storage ${isPersisted ? 'granted' : 'denied'}`);
      return isPersisted;
    }
    return false;
  }
}
```

### Storage Best Practices

1. **Always check available storage** before storing large files
2. **Implement cleanup strategies** for old/unused files
3. **Request persistent storage** for important data
4. **Use compression** if needed (Compression Streams API)
5. **Handle QuotaExceededError** gracefully
6. **Provide offline functionality** with Service Workers
7. **Monitor storage usage** and warn users appropriately

### File Size Considerations

For 1-50MB EPUB files:
- **IndexedDB**: Ideal, handles this range easily
- **OPFS**: Best performance, perfect for this size
- **Cache API**: Adequate but not designed for this use case
- **localStorage**: Not suitable (5-10MB limit)

All modern storage APIs can handle EPUB files in the 1-50MB range without issues, assuming sufficient device storage is available.