// docs/search.json: what the docs' search box reads (each page's title, description, group, sections and text),
// fetched the first time someone uses it
import type { APIRoute } from 'astro';
import { getCollection, render } from 'astro:content';

export const GET: APIRoute = async () => {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  const pages = await Promise.all((await getCollection('docs')).map(async (d) => {
    const { headings } = await render(d);
    const u = base + 'docs/' + (d.id === 'introduction' ? '' : d.id);
    return { t: d.data.title, d: d.data.description, g: d.data.group, u, x: (d.body || '').replace(/[#*`|>\[\]()_-]+/g, ' ').replace(/\s+/g, ' '), h: headings.filter((h) => h.depth <= 3).map((h) => [h.text, h.slug]) };
  }));
  return new Response(JSON.stringify(pages), { headers: { 'Content-Type': 'application/json' } });
};
