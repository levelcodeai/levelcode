// `node:module` is named in just-bash's defense-in-depth code (error strings only in the browser entry of 3.6.0). Aliased
// so a future version that really imports it still cannot reach a Node built-in from the worker.
export const builtinModules = [];
export const createRequire = () => {
	throw new Error('node:module is not available in the browser');
};
export default { builtinModules, createRequire };
