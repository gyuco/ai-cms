/** Upper bounds that keep a single document within sane sizes (agent or user input). */
export const LIMITS = {
  /** Maximum nesting of `section` blocks. */
  sectionDepth: 6,
  /** Maximum number of blocks in a document, nested ones included. */
  blocks: 2000,
  /** Maximum number of blocks in a single list of children. */
  blocksPerList: 500,
  inlinesPerBlock: 500,
  listItems: 500,
  galleryImages: 200,
  shortText: 300,
  text: 20_000,
  url: 2048,
  html: 200_000,
  jsonLd: 50_000,
  menuDepth: 3,
  menuItems: 100,
} as const;
