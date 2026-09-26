import type {
  Block,
  ButtonBlock,
  GalleryBlock,
  HeadingBlock,
  HtmlBlock,
  ImageBlock,
  ImageData,
  Inline,
  ListBlock,
  QuoteBlock,
  SectionBlock,
} from '@ai-cms/content';
import type { ReactNode } from 'react';
import { linkRel, resolveImageSrc, type RenderOptions } from './options.ts';

interface WithOptions {
  options?: RenderOptions;
}

/** One run of text: `<a>` wraps `<strong>`, which wraps `<em>`, which wraps `<code>`. */
export function InlineText({ inline, options }: { inline: Inline } & WithOptions) {
  let node: ReactNode = inline.text;
  if (inline.code) node = <code>{node}</code>;
  if (inline.italic) node = <em>{node}</em>;
  if (inline.bold) node = <strong>{node}</strong>;
  if (inline.href) {
    node = (
      <a href={inline.href} rel={linkRel(inline.href, options)}>
        {node}
      </a>
    );
  }
  return node;
}

export function Inlines({ content, options }: { content: readonly Inline[] } & WithOptions) {
  return content.map((inline, index) => (
    <InlineText key={index} inline={inline} options={options} />
  ));
}

function Heading({ block }: { block: HeadingBlock }) {
  const Tag = `h${block.level}` as const;
  return <Tag data-cms-block={block.id}>{block.text}</Tag>;
}

function Figure({ image, blockId, options }: { image: ImageData; blockId?: string } & WithOptions) {
  return (
    <figure data-cms-block={blockId} className="cms-image">
      <img
        src={resolveImageSrc(image.src, options)}
        alt={image.decorative ? '' : image.alt}
        width={image.width}
        height={image.height}
        loading="lazy"
        decoding="async"
      />
      {image.caption ? <figcaption>{image.caption}</figcaption> : null}
    </figure>
  );
}

function Image({ block, options }: { block: ImageBlock } & WithOptions) {
  return <Figure image={block} blockId={block.id} options={options} />;
}

function Gallery({ block, options }: { block: GalleryBlock } & WithOptions) {
  return (
    <ul data-cms-block={block.id} className="cms-gallery">
      {block.images.map((image, index) => (
        <li key={index}>
          <Figure image={image} options={options} />
        </li>
      ))}
    </ul>
  );
}

function List({ block, options }: { block: ListBlock } & WithOptions) {
  const Tag = block.ordered ? 'ol' : 'ul';
  return (
    <Tag data-cms-block={block.id}>
      {block.items.map((item, index) => (
        <li key={index}>
          <Inlines content={item} options={options} />
        </li>
      ))}
    </Tag>
  );
}

function Quote({ block, options }: { block: QuoteBlock } & WithOptions) {
  const quote = (
    <blockquote data-cms-block={block.cite ? undefined : block.id}>
      <p>
        <Inlines content={block.content} options={options} />
      </p>
    </blockquote>
  );
  if (!block.cite) return quote;
  // The attribution goes outside the quotation, as recommended by the HTML standard.
  return (
    <figure data-cms-block={block.id} className="cms-quote">
      {quote}
      <figcaption>
        <cite>{block.cite}</cite>
      </figcaption>
    </figure>
  );
}

function Button({ block, options }: { block: ButtonBlock } & WithOptions) {
  return (
    <a
      data-cms-block={block.id}
      className={`cms-button cms-button--${block.variant ?? 'primary'}`}
      href={block.href}
      rel={linkRel(block.href, options)}
    >
      {block.label}
    </a>
  );
}

function Section({ block, options }: { block: SectionBlock } & WithOptions) {
  const Tag = block.tag;
  // aria-label is not allowed on a generic <div>: a labelled div becomes a group.
  const role = Tag === 'div' && block.label ? 'group' : undefined;
  return (
    <Tag data-cms-block={block.id} aria-label={block.label} role={role}>
      <Blocks blocks={block.children} options={options} />
    </Tag>
  );
}

function Html({ block }: { block: HtmlBlock }) {
  // The only raw HTML in the site: `html` blocks are sanitized with an allowlist when the
  // content is saved (normalizePageBody / normalizeLayout, FR-112), so no script can get here.
  return (
    <div
      data-cms-block={block.id}
      className="cms-html"
      dangerouslySetInnerHTML={{ __html: block.html }}
    />
  );
}

/** A single block as semantic HTML; its root element carries `data-cms-block` (FR-146). */
export function BlockView({ block, options }: { block: Block } & WithOptions) {
  switch (block.type) {
    case 'heading':
      return <Heading block={block} />;
    case 'paragraph':
      return (
        <p data-cms-block={block.id}>
          <Inlines content={block.content} options={options} />
        </p>
      );
    case 'image':
      return <Image block={block} options={options} />;
    case 'gallery':
      return <Gallery block={block} options={options} />;
    case 'list':
      return <List block={block} options={options} />;
    case 'quote':
      return <Quote block={block} options={options} />;
    case 'button':
      return <Button block={block} options={options} />;
    case 'section':
      return <Section block={block} options={options} />;
    case 'html':
      return <Html block={block} />;
  }
}

export function Blocks({ blocks, options }: { blocks: readonly Block[] } & WithOptions) {
  return blocks.map((block) => <BlockView key={block.id} block={block} options={options} />);
}
