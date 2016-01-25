/*
Copyright (c) 2015, salesforce.com, inc. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
Neither the name of salesforce.com, inc. nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import _ from 'lodash';
import assert from 'assert';
import cheerio from 'cheerio';
import gulp from 'gulp';
import gulpIgnore from 'gulp-ignore';
import gulpRename from 'gulp-rename';
import gutil from 'gulp-util';
import path from 'path';
import { html as prettyHTML } from 'js-beautify';
import React from 'react';
import ReactDOMServer, { renderToStaticMarkup } from 'react-dom/server';
import through from 'through2';

import Page from 'app_modules/site/components/page';
import PageBody from 'app_modules/site/components/page/body';
import Component from 'app_modules/site/components/page/component';
import ComponentFlavor from 'app_modules/site/components/page/component';

import decorateComponent from 'app_modules/site/util/component/create';
import { generateUI } from './generate-ui';

/**
 * Return true if a file path contains a directory prefixed with an underscore
 *
 * @param {object} file
 * @returns {boolean}
 */
export const excludeUnderscore = file =>
  file.relative
    .split(path.sep)
    .filter(part => /^_/.test(part))
    .reduce(() => true, false);

/**
 * Return a props object with only props prefixed and then strip the prefix
 *
 * @params {object} props
 * @params {string} prefix
 * @returns {object}
 */
export const getPrefixedProps = (props, prefix) => {
  assert.ok(_.isObject(props), 'props must be an object');
  assert.ok(_.isString(prefix), 'prefix must be a string');
  const pattern = new RegExp(`^${_.escapeRegExp(prefix)}`);
  const prefixedProps = _.pick(props, _.keys(props).filter(key => pattern.test(key)));
  return _.mapKeys(prefixedProps, (value, key) => {
    return _.camelCase(key.replace(pattern, ''));
  });
};

/**
 * Try to requre a module and store the result in the provided object
 *
 * @param {object} obj
 * @param {string} key
 * @param {string} path
 */
export const tryRequire = (path, obj, key) => {
  try {
    delete require.cache[require.resolve(path)];
    let m = require(path);
    if (obj) { obj[key] = m; }
    return m;
  } catch (e) {
    return null;
  }
};

/**
 * Render a <PageBody /> inside a <Page /> and render as HTML
 *
 * @param {ReactElement} pageBody
 * @returns {string}
 */
export const renderPage = pageBody => {
  // Get any "page" specific props from the pageBody
  let pageProps = getPrefixedProps(pageBody.props, 'page');
  // Create page element
  let page = React.createElement(Page, pageProps);
  // Construct the HTML
  let $ = cheerio.load(renderToStaticMarkup(page));
  $('#app').append(renderToStaticMarkup(pageBody));
  $('html').before('<!DOCTYPE html>');
  return $.html();
};

/**
 * Return a formatted string of HTML
 */
export const renderExample = element => {
  if (!element) return null;
  let html = renderToStaticMarkup(element);
  const $ = cheerio.load(html);
  // Remove a ".demo-only" wrapping <div>
  $.root().contents().each(function (i, el) {
    const $el = $(el);
    if ($el.hasClass('demo-only')) {
      $el.replaceWith($el.contents());
    }
  });
  // Format
  return prettyHTML($.html(), {
    'indent_size': 2,
    'indent_char': ' ',
    'unformatted': ['a']
  });
};

/**
 * Return the example element for the current flavor
 *
 * @param {object} options
 * @returns {ReactElement|null}
 */
export const getExampleElement = (example, options) => {
  options = _.defaults({}, options, {
    // The keys (in order) that will be checked for a ReactElement
    keys: ['preview', 'default'],
    // If true, the element will be passed to renderElementState
    renderState: true,
    // The state to be rendered
    state: null
  });
  // Get the first valid ReactElement
  let defaultElement = _(options.keys)
    .filter(key => _.has(example, key))
    .map(key => example[key])
    .filter(React.isValidElement)
    .first();
  // Exit early if no state is needed
  if (options.renderState === false) return defaultElement;
  // If no element was found, check to see if states exist
  if (!defaultElement && _.isArray(example.states) && example.states.length) {
    if (React.isValidElement(example.states[0].element)) {
      defaultElement = example.states[0].element;
    }
  }
  if (!defaultElement) return null;
  if (!options.state) return defaultElement;
  if (React.isValidElement(options.state.element)) {
    return options.state.element;
  }
  return defaultElement;
};

/**
 * Return a transform stream that converts JSX to HTML
 *
 * @returns {Stream}
 */
export const gulpRenderPage = () =>
  through.obj((file, enc, next) => {
    try {
      const pageBody = React.cloneElement(require(file.path).default, {});
      const html = renderPage(pageBody);
      // Create the new file
      let newFile = file.clone();
      newFile.contents = new Buffer(html);
      next(null, newFile);
    } catch (err) {
      next(err);
    }
  });

/**
 * Return a transform stream that converts a component object to HTML
 *
 * @returns {Stream}
 */
export const gulpRenderComponentPage = () =>
  through.obj(function (component, enc, next) {
    try {
      // Get examples / markup for each flavor
      component.flavors.forEach(flavor => {
        let example = tryRequire(`ui/${flavor.path}/index.react.example.jsx`);
        if (example) {
          const exampleElement = getExampleElement(example);
          const exampleCodeElement = getExampleElement(example, {
            keys: ['code', 'default'],
            renderState: false
          });
          flavor.example = example;
          flavor.exampleMarkup = renderExample(exampleCodeElement
            ? exampleCodeElement : exampleElement);
        }
      });
      // Render example markup for each flavor and push a corresponding HTML
      // file into the stream
      component.flavors
        // Only get flavors with an example
        .filter(f => f.example)
        .forEach(f => {
          // First, check if the example has states
          if (f.example.states) {
            // Push a new file for each state
            f.example.states.forEach(state => {
              const element = getExampleElement(f.example, { state });
              const id = state.id || _.kebabCase(state.label);
              this.push(new gutil.File({
                path: path.join(f.path, `_${id}.html`),
                contents: new Buffer(renderExample(element))
              }));
            });
          } else {
            // No states were found, just get the single example
            const element = getExampleElement(f.example);
            if (element) {
              // Push a new file for the single example
              this.push(new gutil.File({
                path: path.join(f.path, '_default.html'),
                contents: new Buffer(renderExample(element))
              }));
            }
          }
        });
      // Create the <PageBody> for the component
      const pageBody = (
        <PageBody contentClassName={false}>
          <Component
            component={decorateComponent(component)}
            docs={tryRequire(`ui/${component.path}/index.docs.jsx`)} />
        </PageBody>
      );
      // Push a new HTML page
      next(null, new gutil.File({
        path: path.join(component.path, 'index.html'),
        contents: new Buffer(renderPage(pageBody))
      }));
    } catch (err) {
      next(err);
    }
  });

/**
 * Return a transform stream that converts component objects to HTML and
 * writes the result to disk
 *
 * @param {object[]} components
 * @returns {Stream}
 */
export const generateComponentPages = (components, callback = _.noop) => {
  const stream = through.obj();
  components.forEach(c => stream.write(c));
  stream.end();
  return stream
    .pipe(gulpRenderComponentPage())
    .on('error', callback)
    .pipe(gulp.dest(__PATHS__.www))
    .on('finish', callback);
};

gulp.task('pages:components', () =>
  generateComponentPages(
    _.find(generateUI(), { id: 'components' }).components
  ));

gulp.task('pages:components:utilities', () =>
  generateComponentPages(
    _.find(generateUI(), { id: 'utilities' }).components
  ));

/**
 * Return a transform stream that converts JSX to HTML and
 * writes the result to disk
 *
 * @param {string} src - a glob of .jsx files that export <PageBody/> elements
 * @returns {Stream}
 */
export const generatePages = (src, callback = _.noop) =>
  gulp
    .src(src, { base: __PATHS__.site })
    .pipe(gulpIgnore.exclude(excludeUnderscore))
    .pipe(gulpRenderPage())
    .on('error', callback)
    .pipe(gulpRename({ extname: '.html' }))
    .pipe(gulp.dest(__PATHS__.www))
    .on('finish', callback);

gulp.task('pages', ['pages:components', 'pages:components:utilities'], () =>
  generatePages('./site/**/index.jsx'));
