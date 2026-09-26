import { PageView, pageMetadata, siteEnv, siteUrl } from '@ai-cms/site-kit';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { loadLayouts, loadPage, loadSettings } from '@ai-cms/site-kit/next';

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
  return pageMetadata({
    page: page.body,
    settings: await loadSettings(),
    publicPath: page.publicPath,
    siteUrl: siteUrl(),
    // Staging and unpublished drafts never end up in search engines.
    noindex: siteEnv() === 'staging' || page.draft,
  });
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
