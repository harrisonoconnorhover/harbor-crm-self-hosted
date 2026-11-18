// Both text widgets store the same plain string. No HTML interpretation or
// value rewrite is needed when switching a definition between them.
export const customTextLimit = 65_536;
export const isTextProperty = (type: string) => type === 'text' || type === 'textarea';
export const propertyTypeLabel = (type: string) => type === 'url' ? 'URL' : type === 'email' ? 'Email' : type === 'datetime' ? 'Date and time' : type === 'textarea' ? 'Multi-line text' : type === 'text' ? 'Single-line text' : type;

// Leave room for both snapshots plus metadata in D1's 2 MB history row.
export const recordDataByteLimit = 800_000;
