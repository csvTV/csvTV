export const securityPolicy = "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' https://image.tmdb.org; connect-src 'self' https://api.themoviedb.org https://api.dropboxapi.com https://content.dropboxapi.com https://api.mdblist.com https://www.omdbapi.com https://api.github.com https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const permissionsPolicy = 'camera=(), microphone=(), geolocation=()';
export const appHeaders = {
  'Content-Security-Policy':securityPolicy, 'Permissions-Policy':permissionsPolicy,
  'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff',
};
export const pagesHeaders = '/*\n' + Object.entries(appHeaders).map(([name,value]) => '  ' + name + ': ' + value + '\n').join('');
