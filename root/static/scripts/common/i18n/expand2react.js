/*
 * @flow
 * Copyright (C) 2018 MetaBrainz Foundation
 *
 * This file is part of MusicBrainz, the open internet music database,
 * and is licensed under the GPL version 2, or (at your option) any
 * later version: http://www.gnu.org/licenses/gpl-2.0.txt
 */

import he from 'he';
import * as React from 'react';

import {
  l as lActual,
  ln as lnActual,
  lp as lpActual,
} from '../i18n';

import expand, {
  accept,
  createCondSubstParser,
  createTextContentParser,
  createVarSubstParser,
  error,
  getVarSubstArg,
  gotMatch,
  NO_MATCH_VALUE,
  parseContinuous,
  parseContinuousString,
  parseStringVarSubst,
  saveMatch,
  state,
  substEnd,
  type NO_MATCH,
  type Parser,
  type VarArgs,
} from './expand2';

type Input = Expand2ReactInput;
type Output = Expand2ReactOutput;

const EMPTY_ARRAY: Array<any> = Object.freeze([]);

const textContent = /^[^<>{}]+/;
const condSubstThenTextContent = /^[^<>{}|]+/;
const percentSign = /(%)/;
const linkSubstStart = /^\{([0-9A-z_]+)\|/;
const htmlTagStart = /^<(?=[a-z])/;
const htmlTagName = /^(a|abbr|br|code|em|li|p|span|strong|ul)(?=[\s\/>])/;
const htmlTagEnd = /^>/;
const htmlSelfClosingTagEnd = /^\s*\/>/;
const htmlAttrStart = /^\s+(?=[a-z])/;
const htmlAttrName = /^(class|href|id|key|rel|target|title)="/;
const htmlAttrTextContent = /^[^{}"]+/;
const hrefValueStart = /^(?:\/|https?:\/\/)/;

function handleTextContentText(text: string) {
  if (typeof state.replacement === 'string') {
    text = text.replace(/%/g, he.encode(state.replacement));
  }
  return he.decode(text);
}

/*
 * `reactTextContentHook`, when overridden from the outside, allows
 * customizing each bit of free text content in the expanded string. This can
 * be used, for example, to wrap them in spans to apply a certain style.
 * (This is how our relationship edit diff display works.)
 *
 * The use of the word "hooks" here is completely unrelated to the React
 * concept with the same name.
 */
export const hooks: {
  reactTextContentHook: ((Expand2ReactOutput) => Expand2ReactOutput) | null,
} = {
  reactTextContentHook: null,
};

function handleTextContentReact(text: string) {
  const replacement = state.replacement;
  const hook = hooks.reactTextContentHook;
  let content;

  if (gotMatch(replacement) && percentSign.test(text)) {
    const parts = text.split(percentSign);
    const result: Array<Output> = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '%') {
        result.push(replacement);
      } else {
        result.push(he.decode(part));
      }
    }
    if (typeof replacement === 'string') {
      content = result.join('');
    } else {
      content = React.createElement(React.Fragment, null, ...result);
    }
  } else {
    content = he.decode(text);
  }

  return hook ? hook(content) : content;
}

const parseRootTextContent = createTextContentParser<Output, Input>(
  textContent,
  handleTextContentReact,
);

const parseVarSubst = createVarSubstParser<Output, Input>(
  getVarSubstArg,
);

const parseLinkSubst = saveMatch<
  React.Element<'a'> | string | NO_MATCH,
  Input,
>(function (args) {
  const name = accept(linkSubstStart);
  if (typeof name !== 'string') {
    return NO_MATCH_VALUE;
  }
  const children = parseRoot(args);
  if (!gotMatch(accept(substEnd))) {
    throw error('expected }');
  }
  if (args.has(name)) {
    let props = args.get(name);
    if (typeof props === 'string') {
      props = ({href: props}: AnchorProps);
    }
    if (!props || typeof props === 'number' || !props.href) {
      throw error('bad link props');
    }
    return React.createElement('a', props, ...children);
  }
  return state.match;
});

function pushChild<T>(
  children: Array<T>,
  match: T,
): Array<T> {
  const lastIndex = children.length - 1;
  if (lastIndex >= 0 &&
      typeof match === 'string' &&
      typeof children[lastIndex] === 'string') {
    children[lastIndex] += match;
  } else {
    children.push(match);
  }
  return children;
}

function concatArrayMatch<T>(
  children: Array<T> | NO_MATCH,
  match: Array<T> | T,
): Array<T> {
  if (!gotMatch(children)) {
    children = [];
  }
  if (Array.isArray(match)) {
    for (let j = 0; j < match.length; j++) {
      pushChild(children, match[j]);
    }
  } else {
    pushChild(children, match);
  }
  return children;
}

function parseContinuousArray<T, V>(
  parsers: $ReadOnlyArray<Parser<Array<T> | T | NO_MATCH, V>>,
  args: VarArgs<V>,
): Array<T> {
  return parseContinuous<Array<T> | T, Array<T>, V>(
    parsers,
    args,
    concatArrayMatch,
    EMPTY_ARRAY,
  );
}

const parseHtmlAttrValue = args => (
  parseContinuousString(htmlAttrValueParsers, args)
);

const parseHtmlAttrValueCondSubst =
  createCondSubstParser<string, Input>(
    args => parseContinuousString(htmlAttrCondSubstThenParsers, args),
    args => parseContinuousString(htmlAttrCondSubstElseParsers, args),
  );

const htmlAttrCondSubstThenParsers = [
  createTextContentParser<string, Input>(
    condSubstThenTextContent,
    handleTextContentText,
  ),
  parseStringVarSubst,
  parseHtmlAttrValueCondSubst,
];

const htmlAttrCondSubstElseParsers = [
  createTextContentParser<string, Input>(
    textContent,
    handleTextContentText,
  ),
  parseStringVarSubst,
  parseHtmlAttrValueCondSubst,
];

const htmlAttrValueParsers = [
  createTextContentParser<string, Input>(
    htmlAttrTextContent,
    handleTextContentText,
  ),
  parseStringVarSubst,
  parseHtmlAttrValueCondSubst,
];

// Keep in sync with the htmlAttrName RegExp above.
type HtmlAttrs = {
  className?: string,
  href?: string,
  id?: string,
  key?: string,
  rel?: string,
  target?: string,
  title?: string,
  ...,
};

function parseHtmlAttr(args) {
  if (!gotMatch(accept(htmlAttrStart))) {
    return NO_MATCH_VALUE;
  }

  let name = accept(htmlAttrName);
  if (typeof name !== 'string') {
    throw error('bad HTML attribute');
  }

  if (name === 'class') {
    name = 'className';
  }

  const value = parseHtmlAttrValue(args);

  if (!gotMatch(accept(/^"/))) {
    throw error('expected "');
  }

  if (name === 'href' && !hrefValueStart.test(value)) {
    throw error('bad href value');
  }

  /*
   * See "Flow errors on unions in computed properties" here:
   * https://medium.com/flow-type/spreads-common-errors-fixes-9701012e9d58
   */
  const attr: HtmlAttrs = {};
  attr[name] = value;
  return attr;
}

const htmlAttrParsers = [parseHtmlAttr];

function parseHtmlTag(args) {
  if (!gotMatch(accept(htmlTagStart))) {
    return NO_MATCH_VALUE;
  }

  const name = accept(htmlTagName);
  if (typeof name !== 'string') {
    throw error('bad HTML tag');
  }

  const attributes = parseContinuousArray<HtmlAttrs, Input>(
    htmlAttrParsers,
    args,
  );

  if (gotMatch(accept(htmlSelfClosingTagEnd))) {
    // Self-closing tag
    return React.createElement(
      name,
      Object.assign({}, ...attributes),
    );
  }

  if (!gotMatch(accept(htmlTagEnd))) {
    throw error('expected >');
  }

  const children = parseRoot(args);

  if (!gotMatch(accept(new RegExp('^</' + name + '>')))) {
    throw error('expected </' + name + '>');
  }

  return React.createElement(
    name,
    Object.assign({}, ...attributes),
    ...children,
  );
}

const parseCondSubst = createCondSubstParser<Array<Output>, Input>(
  args => parseContinuousArray(condSubstThenParsers, args),
  args => parseContinuousArray(condSubstElseParsers, args),
);

const condSubstThenParsers = [
  createTextContentParser<Output, Input>(
    condSubstThenTextContent,
    handleTextContentReact,
  ),
  parseVarSubst,
  parseLinkSubst,
  parseCondSubst,
  parseHtmlTag,
];

const condSubstElseParsers = [
  parseRootTextContent,
  parseVarSubst,
  parseLinkSubst,
  parseCondSubst,
  parseHtmlTag,
];

const rootParsers = [
  parseRootTextContent,
  parseVarSubst,
  parseLinkSubst,
  parseCondSubst,
  parseHtmlTag,
];

const parseRoot = args => parseContinuousArray(rootParsers, args);

/*
 * `expand2react` takes a translated string and
 *  (1) interpolates values (React nodes) into it,
 *  (2) converts HTML to React elements.
 *
 * The output is intended for use with React, so the result is a valid
 * React node (a string, a React element, or null).
 *
 * A (safe) subset of HTML is supported, in addition to the variable
 * substitution syntax. In order to display a character reserved by
 * either syntax, HTML character entities must be used.
 */
export default function expand2react(
  source: string,
  args?: ?{+[string]: Input, ...},
): Output {
  const result = expand<$ReadOnlyArray<Output>, Input>(
    parseRoot,
    source,
    args,
  );
  if (typeof result === 'string') {
    return result;
  }
  return result.length ? (
    result.length > 1
      ? React.createElement(React.Fragment, null, ...result)
      : result[0]
  ) : '';
}

export const l = (
  key: string,
  args?: ?{+[string]: Input, ...},
) => expand2react(lActual(key), args);

export const ln = (
  skey: string,
  pkey: string,
  val: number,
  args?: ?{+[string]: Input, ...},
) => expand2react(lnActual(skey, pkey, val), args);

export const lp = (
  key: string,
  context: string,
  args?: ?{+[string]: Input, ...},
) => expand2react(lpActual(key, context), args);
