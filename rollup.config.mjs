export default {
  input: 'dist/esm/index.js',
  output: [
    {
      file: 'dist/plugin.js',
      format: 'iife',
      name: 'capacitorOverair',
      globals: { '@capacitor/core': 'capacitorExports' },
      sourcemap: true,
      // The web fallback is loaded with a dynamic import so a device build
      // never parses it; a single-file bundle has to fold it back in.
      inlineDynamicImports: true,
    },
    { file: 'dist/plugin.cjs.js', format: 'cjs', sourcemap: true, inlineDynamicImports: true },
  ],
  external: ['@capacitor/core'],
};
