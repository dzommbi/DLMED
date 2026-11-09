import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.env.GITHUB_SHA || process.argv[2] || '';
const outputDir = path.resolve(process.argv[3] || path.join(sourceRoot, 'dist'));

if (!/^[a-f\d]{7,64}$/i.test(version)) {
  throw new Error('Pass the deployment commit SHA as the first argument (7–64 hexadecimal characters).');
}
if (outputDir === sourceRoot || sourceRoot.startsWith(`${outputDir}${path.sep}`)) {
  throw new Error('The output directory must not contain or replace the source tree.');
}

try {
  if (fs.readdirSync(outputDir).length) {
    throw new Error(`Refusing to overwrite a non-empty output directory: ${outputDir}`);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
fs.mkdirSync(outputDir, { recursive: true });

function copyTree(source, destination, relative = '') {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const relativePath = relative ? path.join(relative, entry.name) : entry.name;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const normalized = relativePath.split(path.sep).join('/');
    if (['.git', '.github', 'node_modules', 'dist'].includes(normalized.split('/')[0])) continue;
    if (path.resolve(sourcePath) === outputDir || outputDir.startsWith(`${path.resolve(sourcePath)}${path.sep}`)) continue;
    if (entry.isDirectory()) {
      fs.mkdirSync(destinationPath, { recursive: true });
      copyTree(sourcePath, destinationPath, relativePath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function walkFiles(directory, relative = '') {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolutePath, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function withVersion(url) {
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const existingVersion = /([?&])v=[^&]*/i;
  const versioned = existingVersion.test(beforeHash)
    ? beforeHash.replace(existingVersion, `$1v=${version}`)
    : `${beforeHash}${beforeHash.includes('?') ? '&' : '?'}v=${version}`;
  return `${versioned}${hash}`;
}

function isLocalUrl(url) {
  return !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url);
}

function rootPathFor(url, htmlPath) {
  const rawPath = url.split(/[?#]/, 1)[0];
  if (!rawPath) return null;
  const rootPath = rawPath.startsWith('/')
    ? rawPath.replace(/^\/+/, '')
    : path.posix.normalize(path.posix.join(path.posix.dirname(htmlPath), rawPath));
  if (rootPath === '..' || rootPath.startsWith('../')) return null;
  return rootPath === '.' ? 'index.html' : rootPath;
}

function versionedLocalAssets(html, htmlPath, assetCachePaths) {
  const transform = (tag, attribute) => {
    const attributePattern = new RegExp(`(^|\\s)${attribute}\\s*=\\s*(["'])(.*?)\\2`, 'i');
    const match = tag.match(attributePattern);
    if (!match || !isLocalUrl(match[3])) return tag;
    const url = match[3];
    const ext = path.posix.extname(url.split(/[?#]/, 1)[0]).toLowerCase();
    if (!['.js', '.mjs', '.css'].includes(ext)) return tag;
    const rootPath = rootPathFor(url, htmlPath);
    if (!rootPath) throw new Error(`Invalid local asset path in ${htmlPath}: ${url}`);
    const diskPath = path.resolve(outputDir, ...rootPath.split('/'));
    if (!diskPath.startsWith(`${outputDir}${path.sep}`) || !fs.existsSync(diskPath) || !fs.statSync(diskPath).isFile()) {
      throw new Error(`Missing local ${ext.slice(1).toUpperCase()} asset referenced by ${htmlPath}: ${url}`);
    }
    assetCachePaths.add(`./${rootPath}?v=${version}`);
    const replacement = `${match[1]}${attribute}=${match[2]}${withVersion(url)}${match[2]}`;
    return tag.replace(attributePattern, replacement);
  };

  html = html.replace(/<script\b[^>]*>/gi, tag => transform(tag, 'src'));
  html = html.replace(/<link\b[^>]*>/gi, tag => {
    const rel = tag.match(/(?:^|\s)rel\s*=\s*(["'])(.*?)\1/i)?.[2] || '';
    return /\bstylesheet\b/i.test(rel) ? transform(tag, 'href') : tag;
  });
  return html;
}

copyTree(sourceRoot, outputDir);
const outputFiles = walkFiles(outputDir);
const htmlFiles = outputFiles.filter(file => file.toLowerCase().endsWith('.html'));
const assetCachePaths = new Set();
for (const htmlPath of htmlFiles) {
  const absolutePath = path.join(outputDir, ...htmlPath.split('/'));
  const html = versionedLocalAssets(fs.readFileSync(absolutePath, 'utf8'), htmlPath, assetCachePaths);
  fs.writeFileSync(absolutePath, html);
}

const workerPath = path.join(outputDir, 'sw.js');
let worker = fs.readFileSync(workerPath, 'utf8');
const versionMatch = worker.match(/const APP_VERSION\s*=\s*(['"])[^'"]*\1\s*;/);
if (!versionMatch) throw new Error('Could not find the APP_VERSION declaration in sw.js.');
worker = worker.replace(versionMatch[0], `const APP_VERSION = '${version}';`);

const markerBypass = "if (url.origin === self.location.origin && url.pathname.endsWith('/dlmed-version.json')) return;";
if (!worker.includes(markerBypass)) {
  const requestUrlLine = '  const url = new URL(request.url);';
  if (!worker.includes(requestUrlLine)) throw new Error('Could not find the worker request URL handler.');
  worker = worker.replace(requestUrlLine, `${requestUrlLine}\n\n  // Always fetch the deployment marker from the origin; do not cache it.\n  ${markerBypass}`);
}

const filesMatch = worker.match(/const APP_FILES\s*=\s*\[([\s\S]*?)\]\s*;/);
if (!filesMatch) throw new Error('Could not find the APP_FILES list in sw.js.');
const configuredFiles = [...filesMatch[1].matchAll(/(['"])(.*?)\1/g)].map(match => match[2]);
const cacheFiles = new Set();
for (const configured of configuredFiles) {
  const local = configured.startsWith('/') ? configured.slice(1) : configured;
  const rootPath = rootPathFor(local, 'index.html');
  if (!rootPath) continue;
  const diskPath = path.resolve(outputDir, ...rootPath.split('/'));
  if (!diskPath.startsWith(`${outputDir}${path.sep}`) || !fs.existsSync(diskPath)) continue;
  let cachePath = local;
  if (/\.(?:m?js|css)(?:[?#]|$)/i.test(local)) cachePath = withVersion(local);
  cacheFiles.add(cachePath);
}
for (const requiredPage of ['./index.html', './quiz.html', './exam.html', './privacy/', './privacy/index.html', './terms/', './terms/index.html']) {
  const rootPath = rootPathFor(requiredPage, 'index.html');
  const diskPath = path.resolve(outputDir, ...rootPath.split('/'));
  if (fs.existsSync(diskPath)) cacheFiles.add(requiredPage);
}
for (const asset of assetCachePaths) cacheFiles.add(asset);

worker = worker.replace(filesMatch[0], `const APP_FILES = ${JSON.stringify([...cacheFiles], null, 2)};`);
fs.writeFileSync(workerPath, worker);

const versionFile = path.join(outputDir, 'dlmed-version.json');
if (fs.existsSync(versionFile)) throw new Error('dlmed-version.json already exists in the source; refusing to replace it.');
fs.writeFileSync(versionFile, `${JSON.stringify({ version }, null, 2)}\n`);

console.log(`Prepared DLMed Pages release ${version}`);
console.log(`Versioned ${assetCachePaths.size} local JavaScript/CSS assets across ${htmlFiles.length} HTML pages.`);
console.log(`Generated ${path.relative(sourceRoot, outputDir) || outputDir}/dlmed-version.json`);
