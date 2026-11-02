// The docs (src/content/docs/*.md): one Markdown file per page, its place in the sidebar from its frontmatter.
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

export const GROUPS = ['Get started', 'Using Playpex', 'Build plugins', 'Build clients'] as const;

const docs = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    group: z.enum(GROUPS),
    order: z.number(),
  }),
});

export const collections = { docs };
