const webpack = require('webpack')
const path = require('path')

module.exports = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  devtool: 'eval-source-map',
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
      }
    ]
  },
  devServer: {
    contentBase: path.resolve(__dirname, 'public/'),
    publicPath: '/js/',
    compress: true,
    port: 3000
  }
}
