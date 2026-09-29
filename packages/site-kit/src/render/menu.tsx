import type { Menu, MenuItem } from '@ai-cms/content';
import { linkRel, type RenderOptions } from './options.ts';

function Items({ items, options }: { items: readonly MenuItem[]; options?: RenderOptions }) {
  return (
    <ul>
      {items.map((item) => (
        <li key={`${item.href}|${item.label}`}>
          <a href={item.href} rel={linkRel(item.href, options)}>
            {item.label}
          </a>
          {item.children && item.children.length > 0 ? (
            <Items items={item.children} options={options} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The main menu of the site as a navigation landmark. */
export function MenuNav({
  menu,
  nodePath,
  options,
}: {
  menu: Menu;
  /** Public tree path, for `data-cms-node`. */
  nodePath: string;
  options?: RenderOptions;
}) {
  return (
    <nav aria-label="Menu principale" data-cms-node={nodePath}>
      <Items items={menu.items} options={options} />
    </nav>
  );
}
