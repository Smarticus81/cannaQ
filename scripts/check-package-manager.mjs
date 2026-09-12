if (!process.env.npm_config_user_agent?.startsWith('pnpm/')) {
  console.error('Use pnpm install (see packageManager in package.json).');
  process.exit(1);
}
