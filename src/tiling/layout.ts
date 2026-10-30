import type { Hemisphere, ImplicitTile } from './grid';

// The storage layout of a tileset, relative to its root: tileset.json, content/{h}/{level}/{x}/{y}.glb and
// subtrees/{h}/{level}/{x}/{y}.subtree, where h is the hemisphere (0 west, 1 east).

const TILESET_KEY = 'tileset.json';

const contentUriTemplate = (hemisphere: Hemisphere): string => `content/${hemisphere}/{level}/{x}/{y}.glb`;

const subtreeUriTemplate = (hemisphere: Hemisphere): string => `subtrees/${hemisphere}/{level}/{x}/{y}.subtree`;

const fillTemplate = (template: string, tile: ImplicitTile): string =>
  template.replace('{level}', String(tile.level)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));

const getContentKey = (tile: ImplicitTile): string => fillTemplate(contentUriTemplate(tile.hemisphere), tile);

const getSubtreeKey = (tile: ImplicitTile): string => fillTemplate(subtreeUriTemplate(tile.hemisphere), tile);

export { TILESET_KEY, contentUriTemplate, subtreeUriTemplate, getContentKey, getSubtreeKey };
