export function mediaType(path) {
  const extension = path.split(/[\\/]/).pop().split('.').pop().toLowerCase();
  const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', pdf: 'application/pdf' };
  return Object.hasOwn(types, extension) ? types[extension] : null;
}
