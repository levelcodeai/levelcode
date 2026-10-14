// `node:zlib` is imported by just-bash for gzip/gunzip/zcat (and `rg -z`). The shell does not offer them (README §8): the
// names are removed from the command list and answer "command not found". This stub only has to satisfy the import.
const unavailable = () => {
	throw new Error('zlib is not available in the browser');
};
export const constants = {};
export const gzipSync = unavailable;
export const gunzipSync = unavailable;
export default { constants, gzipSync, gunzipSync };
