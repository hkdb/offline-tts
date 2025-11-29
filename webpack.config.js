import path from 'path';
import { fileURLToPath } from 'url';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import CopyPlugin from 'copy-webpack-plugin';
import TerserPlugin from 'terser-webpack-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  mode: 'production',
  devtool: 'source-map',
  entry: {
    background: './src/background.js',
    offscreen: './src/offscreen.js',
    popup: './src/popup.js',
    content: './src/content.js',
  },
  output: {
    path: path.resolve(__dirname, 'build'),
    filename: '[name].js',
  },
  optimization: {
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          compress: {
            // Remove console.log, console.debug, console.trace
            // Keep console.error and console.warn
            drop_console: ['log', 'debug', 'trace'],
          },
        },
      }),
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/offscreen.html',
      chunks: ['offscreen'],
      filename: 'offscreen.html',
    }),
    new HtmlWebpackPlugin({
      template: './src/popup.html',
      chunks: ['popup'],
      filename: 'popup.html',
    }),
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: '.' },
        { from: 'icons', to: 'icons' },
        // Copy ONNX Runtime WASM and MJS files from node_modules
        { from: 'node_modules/onnxruntime-web/dist/*.wasm', to: 'lib/[name][ext]' },
        { from: 'node_modules/onnxruntime-web/dist/*.mjs', to: 'lib/[name][ext]' },
        // Copy PDF.js worker
        { from: 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs', to: 'lib/pdf.worker.min.mjs' },
        { from: 'assets', to: 'assets' },
        { from: 'src/popup.css', to: 'popup.css' },
      ],
    }),
  ],
  experiments: {
    topLevelAwait: true,
  },
};
