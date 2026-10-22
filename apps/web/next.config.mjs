/** Static export: the web app is a client of the MOTIF API and can be hosted on any CDN. */
export default {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
};
