'use strict'

/**
 * webpack configuration for zedide frontend
 *
 * rob andrews <rob@aphlor.org>
 */

const webpack = require('webpack')
const path = require('path')
const TerserPlugin = require('terser-webpack-plugin')

module.exports = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  devtool: process.env.NODE_ENV === 'production' ? false : 'inline-source-map',
  optimization: {
    minimize: process.env.NODE_ENV === 'production' ? true : false,
    minimizer: [
      new TerserPlugin({
        test: /\.js(\?.*)?$/i
      })
    ]
  },
  entry: {
    frontend: './src/frontend/index.js'
  },
  output: {
    path: path.resolve(__dirname, 'public/js/'),
    filename: '[name].bundle.js',
  },
  module: {
    rules: [
      {
        test: /\.css$/i,
        use: ['style-loader', 'css-loader']
      },
      {
        test: /\.js$/i,
        use: ['babel-loader']
      }
    ]
  },
  devServer: {
    contentBase: path.resolve(__dirname, 'public/'),
    publicPath: '/js/',
    compress: true,
    host: '0.0.0.0',
    port: 4000,
    proxy: {
      '/api': 'http://localhost:3000'
    }
  }
}
