import crypto from "node:crypto";
import { getDb } from "../database/connection";

export type TagItemType = "invoice" | "customer";

/**
 * Trim and collapse whitespace, drop empties, and dedupe case-insensitively
 * (preserving the casing of the first occurrence).
 */
function normalize(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim().replace(/\s+/g, " ");
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Delete tag rows no longer referenced by any item (shared with setItemTags). */
function pruneUnusedTags(): void {
  const db = getDb();
  db.run(
    `DELETE FROM tags WHERE NOT EXISTS (
       SELECT 1 FROM item_tags WHERE item_tags.tag_id = tags.id
     )`,
  );
}

/**
 * Replace the tags on an item with the given set. Returns the stored names
 * (existing tags keep their original casing even when re-added with different
 * casing). Orphaned tag rows are pruned in the same transaction.
 */
export function setItemTags(itemId: string, itemType: TagItemType, names: string[]): string[] {
  const db = getDb();
  const clean = normalize(names);
  const stored: string[] = [];

  db.transaction(() => {
    db.run("DELETE FROM item_tags WHERE item_id = ? AND item_type = ?", [itemId, itemType]);

    for (const name of clean) {
      const existing = db
        .query("SELECT id, name FROM tags WHERE LOWER(name) = LOWER(?)")
        .get(name) as { id: string; name: string } | null;
      const tagId = existing?.id ?? crypto.randomBytes(16).toString("hex");
      const tagName = existing?.name ?? name;
      if (!existing) {
        db.run("INSERT INTO tags (id, name) VALUES (?, ?)", [tagId, tagName]);
      }
      db.run("INSERT OR IGNORE INTO item_tags (tag_id, item_id, item_type) VALUES (?, ?, ?)", [
        tagId,
        itemId,
        itemType,
      ]);
      stored.push(tagName);
    }

    pruneUnusedTags();
  })();

  return stored;
}

export function getTagsForItem(itemId: string, itemType: TagItemType): string[] {
  const db = getDb();
  return (
    db
      .query(
        `SELECT t.name FROM tags t
         JOIN item_tags it ON it.tag_id = t.id
         WHERE it.item_id = ? AND it.item_type = ?
         ORDER BY t.name COLLATE NOCASE`,
      )
      .all(itemId, itemType) as { name: string }[]
  ).map((r) => r.name);
}

/**
 * Load tags for a batch of item ids in one query (for list pages). Returns a
 * map of item id → sorted tag names.
 */
export function getTagsForItems(itemIds: string[], itemType: TagItemType): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (itemIds.length === 0) return map;
  const db = getDb();
  const placeholders = itemIds.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT it.item_id, t.name FROM item_tags it
       JOIN tags t ON t.id = it.tag_id
       WHERE it.item_type = ? AND it.item_id IN (${placeholders})
       ORDER BY t.name COLLATE NOCASE`,
    )
    .all(itemType, ...itemIds) as { item_id: string; name: string }[];
  for (const row of rows) {
    const arr = map.get(row.item_id);
    if (arr) arr.push(row.name);
    else map.set(row.item_id, [row.name]);
  }
  return map;
}

export function removeItemTags(itemId: string, itemType: TagItemType): void {
  const db = getDb();
  db.transaction(() => {
    db.run("DELETE FROM item_tags WHERE item_id = ? AND item_type = ?", [itemId, itemType]);
    pruneUnusedTags();
  })();
}

/**
 * All tags ever used, with the number of tagged items. Primarily feeds the
 * tag filter suggestions and the tag input autocomplete.
 */
export function listTags(): { name: string; count: number }[] {
  const db = getDb();
  return db
    .query(
      `SELECT t.name, COUNT(it.tag_id) AS count FROM tags t
       LEFT JOIN item_tags it ON it.tag_id = t.id
       GROUP BY t.id
       ORDER BY t.name COLLATE NOCASE`,
    )
    .all() as { name: string; count: number }[];
}
