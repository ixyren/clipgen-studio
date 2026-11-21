#!/usr/bin/env node
'use strict';

const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
if (!process.env.MEMORYBANK_DIR) {
  process.env.MEMORYBANK_DIR = path.join(REPO_ROOT, '.memorybank');
}

const DEFAULT_NAMESPACE = process.env.MEMORYBANK_DEFAULT_NAMESPACE || 'clipgen-studio';
const NAMESPACED_CMDS = new Set([
  'store',
  'recall',
  'search',
  'list',
  'get',
  'update',
  'delete',
  'stats',
]);

const cmd = process.argv[2];
const hasNsFlag = process.argv.slice(2).some((arg) => arg.startsWith('--namespace='));
if (cmd && NAMESPACED_CMDS.has(cmd) && !hasNsFlag) {
  process.argv.push(`--namespace=${DEFAULT_NAMESPACE}`);
}

try {
  require(path.join(REPO_ROOT, 'node_modules/@ura-dev/memorybank/bin/cli.js'));
} catch {
  require('@ura-dev/memorybank/bin/cli.js');
}
