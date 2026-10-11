// just-bash uses the global `Buffer` in three places (base64 -d, gzip, curl's auth header). A worker has none. This file
// is injected into the bundle by build.mjs: the `buffer` package (MIT) that the Code-OSS checkout already depends on.
import { Buffer } from 'buffer';
export { Buffer };
