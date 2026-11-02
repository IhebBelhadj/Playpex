// A Sätteri mdast plugin for src/content/docs: a link to another page by its bare name ("install-the-server",
// "hooks#play-collect") goes to <base>docs/<name>; a link from the site's root ("/plugins", "/#download") gets the
// base path the site is published under. Other links are left alone.
export default function docLinks(base = '/') {
  const root = base.replace(/\/?$/, '/');
  return {
    name: 'playpex-doc-links',
    link(node, ctx) {
      const u = node.url || '';
      let to;
      if (/^[a-z0-9-]+(#.*)?$/.test(u)) to = root + 'docs/' + (u.startsWith('introduction') ? u.slice('introduction'.length) : u);
      else if (u.startsWith('/') && !u.startsWith('//')) to = root + u.slice(1);
      if (to) ctx.setProperty(node, 'url', to);
    },
  };
}
