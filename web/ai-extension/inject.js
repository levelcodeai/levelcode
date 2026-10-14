// What esbuild substitutes for the Node globals the extension's sources mention.
import proc from './shims/process.js';
import { Buffer } from 'buffer';
export { proc as process, Buffer };
