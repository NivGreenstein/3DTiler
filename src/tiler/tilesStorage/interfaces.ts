interface TilesStorage {
  /**
   * Stores an object at the key (a path relative to the tileset root), replacing it if it exists.
   */
  put: (key: string, data: Buffer, contentType: string) => Promise<void>;
  /**
   * Deletes the objects at the keys, missing objects are ignored.
   */
  delete: (keys: string[]) => Promise<void>;
  exists: (key: string) => Promise<boolean>;
}

export type { TilesStorage };
