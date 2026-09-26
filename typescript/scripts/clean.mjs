// Removes dist/ before a build, so a file deleted from src/ cannot survive in a package.
import { rmSync } from 'node:fs';

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
