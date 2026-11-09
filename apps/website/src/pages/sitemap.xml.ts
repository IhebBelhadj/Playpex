// sitemap.xml: every page of the site (add new pages to PAGES as they are built).
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { RELEASE } from '../data/site';

const PAGES = ['', 'server', 'tv', 'mobile', 'manager', 'plugins', 'releases', 'privacy'];

export const GET: APIRoute = async ({ site }) => {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  const docs = (await getCollection('docs')).map((d) => 'docs/' + (d.id === 'introduction' ? '' : d.id));
  const urls = [...PAGES, ...docs].map((p) => `  <url><loc>${new URL(base + p, site).href}</loc><lastmod>${RELEASE.date}</lastmod></url>`).join('\n');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
