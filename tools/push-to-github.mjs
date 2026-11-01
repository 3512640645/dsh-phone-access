#!/usr/bin/env node
/**
 * 把当前目录推成一个新的 GitHub 仓库（不需要安装 git，直接走 Git Data API）。
 *
 * 用法：
 *   set GITHUB_TOKEN=ghp_xxx
 *   node push-to-github.mjs --owner <你的用户名> --repo dsh-phone-access --public
 *
 * 可选项：
 *   --dir <path>      要推送的目录，默认脚本所在目录的上一级
 *   --branch <name>   默认 main
 *   --message <msg>   commit 信息
 *   --private         默认就是私有；要公开用 --public
 *   --api <base>      默认 https://api.github.com（网络受限时可换代理入口）
 *
 * 会自动跳过：.git、bin、shots、日志、密钥与地址文件（见 SKIP 规则）。
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const API = flag('api', 'https://api.github.com');
const BRANCH = flag('branch', 'main');
const MESSAGE = flag('message', 'chore: publish dsh-phone-access');
const IS_PUBLIC = has('public');
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
const OWNER = flag('owner', '');
const REPO = flag('repo', 'dsh-phone-access');
const ROOT = path.resolve(flag('dir', path.join(import.meta.dirname ?? '.', '..')));

if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN（需要一个带 repo 权限的 token）');
  process.exit(2);
}

// 绝不入库的东西：密钥、地址、日志、二进制、截图、本地流程文件
const SKIP_DIRS = new Set(['.git', 'bin', 'shots', 'node_modules', '.edge-profile']);
const SKIP_FILES = new Set(['phone-key.txt', 'public-url.txt', 'phone-url.txt', 'tailscale-url.txt']);
const SKIP_PATTERNS = [/\.log$/i, /^flow-(ui|chat|final|debug).*\.json$/i, /\.(exe|msi|zip)$/i];

async function api(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-phone-access-push',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* 有些端点返回空体 */ }
  if (!res.ok) {
    const message = parsed?.message ?? text.slice(0, 200);
    throw new Error(`${method} ${endpoint} -> ${res.status} ${message}`);
  }
  return parsed;
}

function collect(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collect(path.join(dir, entry.name), `${prefix}${entry.name}/`));
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    if (SKIP_PATTERNS.some((re) => re.test(entry.name))) continue;
    out.push({ path: `${prefix}${entry.name}`, absolute: path.join(dir, entry.name) });
  }
  return out;
}

const files = collect(ROOT);
console.log(`将推送 ${files.length} 个文件（${ROOT}）`);
for (const f of files) console.log(`  ${f.path}`);

const me = await api('GET', '/user');
const owner = OWNER || me.login;
console.log(`\n账号：${me.login}  目标：${owner}/${REPO}（${IS_PUBLIC ? '公开' : '私有'}）`);

let repo = null;
try {
  repo = await api('GET', `/repos/${owner}/${REPO}`);
  console.log('仓库已存在，直接往里推 commit');
} catch {
  repo = await api('POST', '/user/repos', {
    name: REPO,
    description: 'Access the DeepSeek Harness (DSH Desktop) web GUI from your phone: reverse proxy + mobile UI layer, no DSH changes.',
    private: !IS_PUBLIC,
    auto_init: false,
    has_issues: true,
    has_wiki: false,
  });
  console.log(`已创建仓库：${repo.html_url}`);
}

const tree = [];
// 空仓库（还没有任何提交）时，Git Data API 会回 409 "Git Repository is empty"。
// 先用 Contents API 建一个初始提交，之后就能用 Git Data API 一次性推剩下的文件。
let pending = files.slice();
let baseTree = null;
let parents = [];
try {
  const ref = await api('GET', `/repos/${owner}/${REPO}/git/ref/heads/${BRANCH}`);
  parents = [ref.object.sha];
  const commit = await api('GET', `/repos/${owner}/${REPO}/git/commits/${ref.object.sha}`);
  baseTree = commit.tree.sha;
  console.log(`已有分支 ${BRANCH}（${ref.object.sha.slice(0, 7)}），在它之上追加提交`);
} catch {
  const first = files[0];
  await api('PUT', `/repos/${owner}/${REPO}/contents/${first.path}`, {
    message: 'chore: bootstrap repository',
    content: fs.readFileSync(first.absolute).toString('base64'),
    branch: BRANCH,
  });
  const ref = await api('GET', `/repos/${owner}/${REPO}/git/ref/heads/${BRANCH}`);
  parents = [ref.object.sha];
  const commit = await api('GET', `/repos/${owner}/${REPO}/git/commits/${ref.object.sha}`);
  baseTree = commit.tree.sha;
  pending = files.slice(1);
  console.log(`空仓库：已用 Contents API 建初始提交（${first.path}），继续推剩下 ${pending.length} 个`);
}

for (const file of pending) {
  const content = fs.readFileSync(file.absolute);
  const blob = await api('POST', `/repos/${owner}/${REPO}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  process.stdout.write('.');
}
console.log(`\n已上传 ${tree.length} 个 blob`);

const newTree = await api('POST', `/repos/${owner}/${REPO}/git/trees`, {
  tree,
  ...(baseTree ? { base_tree: baseTree } : {}),
});
const commit = await api('POST', `/repos/${owner}/${REPO}/git/commits`, {
  message: MESSAGE,
  tree: newTree.sha,
  parents,
});

await api('PATCH', `/repos/${owner}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });

console.log(`\n完成：${repo.html_url}  commit ${commit.sha.slice(0, 7)}`);
