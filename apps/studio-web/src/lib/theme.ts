/** Theme persistence (shared by the root layout's inline script and the client-side toggle). */
export const THEME_STORAGE_KEY = 'vc-studio-theme';

/**
 * Inline script for <head>: applies the saved theme (or the OS preference) before first paint so there is no
 * flash. Kept tiny and dependency-free. Lives in a plain (non-client) module so the layout receives the string.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");var d=t?t==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;
