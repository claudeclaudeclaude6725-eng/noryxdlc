const fs = require('fs');
const path = require('path');
const { minify: minifyHtml } = require('html-minifier-terser');
const CleanCSS = require('clean-css');
const terser = require('terser');

const root = __dirname;
const out = path.join(root, 'public');
const sources = {
  index: path.join(root, 'index.html'),
  htmlDir: path.join(root, 'html'),
  cssDir: path.join(root, 'css'),
  jsDir: path.join(root, 'js'),
  assetsDir: path.join(root, 'public', 'assets')
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function walk(dir, filter) {
  const outFiles = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) outFiles.push(...walk(full, filter));
    else if (!filter || filter(full)) outFiles.push(full);
  }
  return outFiles;
}

async function minifyAndWriteHtml(src, dest) {
  const content = fs.readFileSync(src, 'utf8');
  const minified = await minifyHtml(content, {
    collapseWhitespace: true,
    conservativeCollapse: true,
    removeComments: true,
    removeRedundantAttributes: true,
    removeScriptTypeAttributes: true,
    removeStyleLinkTypeAttributes: true,
    minifyCSS: true,
    minifyJS: true
  });
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, minified);
}

function minifyCssFile(src, dest) {
  const content = fs.readFileSync(src, 'utf8');
  const result = new CleanCSS({ level: 2 }).minify(content);
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, result.styles);
}

async function minifyJsFile(src, dest) {
  const content = fs.readFileSync(src, 'utf8');
  const result = await terser.minify(content, {
    compress: {
      passes: 2,
      drop_console: false,
      keep_fargs: false,
      ecma: 2020
    },
    mangle: {
      toplevel: false
    },
    format: {
      comments: false
    }
  });
  if (!result.code) throw new Error('Failed to minify ' + src);
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, result.code);
}

async function main() {
  ensureDir(out);
  ensureDir(path.join(out, 'html'));
  ensureDir(path.join(out, 'css'));
  ensureDir(path.join(out, 'js'));

  await minifyAndWriteHtml(sources.index, path.join(out, 'index.html'));

  for (const file of walk(sources.htmlDir, (f) => f.endsWith('.html'))) {
    const rel = path.relative(sources.htmlDir, file);
    await minifyAndWriteHtml(file, path.join(out, 'html', rel));
  }

  for (const file of walk(sources.cssDir, (f) => f.endsWith('.css'))) {
    const rel = path.relative(sources.cssDir, file);
    minifyCssFile(file, path.join(out, 'css', rel));
  }

  for (const file of walk(sources.jsDir, (f) => f.endsWith('.js'))) {
    const rel = path.relative(sources.jsDir, file);
    await minifyJsFile(file, path.join(out, 'js', rel));
  }

  // Keep assets intact; production serves them from public/assets.
  for (const file of walk(sources.assetsDir)) {
    const rel = path.relative(path.join(root, 'public'), file);
    copyFile(file, path.join(out, rel));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
