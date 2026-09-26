import { PageView, siteUrl } from '@ai-cms/site-kit';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { loadLayouts, loadPage, loadSettings } from '../../lib/cms.ts';

interface Props {
  params: Promise<{ slug?: string[] }>;
}

async function publicPath({ params }: Props): Promise<string> {
  const { slug = [] } = await params;
  return `/${slug.join('/')}`;
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const page = await loadPage(await publicPath(props));
  if (!page) return {};
  const settings = await loadSettings();
  const title = page.body.meta.title
    ? settings.titleTemplate.replaceAll('%s', page.body.meta.title)
    : settings.name;
  return { title: { absolute: title } };
}

/** Catch-all route: every static page comes from the published content (TECHNICAL §4.1). */
export default async function ContentPage(props: Props) {
  const page = await loadPage(await publicPath(props));
  if (!page) notFound();
  const { header, footer } = await loadLayouts();
  return (
    <PageView
      page={page.body}
      nodePath={page.nodePath}
      header={header}
      footer={footer}
      options={{ siteOrigin: siteUrl() }}
    />
  );
}
