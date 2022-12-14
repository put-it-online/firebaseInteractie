/**
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Path } from '../Path';
import { RepoInfo } from '../../RepoInfo';
import { warnIfPageIsSecure, warn, fatal } from '../util';

/**
 * @param {!string} pathString
 * @return {string}
 */
function decodePath(pathString: string): string {
  let pathStringDecoded = '';
  const pieces = pathString.split('/');
  for (let i = 0; i < pieces.length; i++) {
    if (pieces[i].length > 0) {
      let piece = pieces[i];
      try {
        piece = decodeURIComponent(piece.replace(/\+/g, ' '));
      } catch (e) {}
      pathStringDecoded += '/' + piece;
    }
  }
  return pathStringDecoded;
}

/**
 * @param {!string} queryString
 * @return {!{[key:string]:string}} key value hash
 */
function decodeQuery(queryString: string): { [key: string]: string } {
  let results = {};
  if (queryString.charAt(0) === '?') {
    queryString = queryString.substring(1);
  }
  for (const segment of queryString.split('&')) {
    if (segment.length === 0) {
      continue;
    }
    const kv = segment.split('=');
    if (kv.length === 2) {
      results[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]);
    } else {
      warn(`Invalid query segment '${segment}' in query '${queryString}'`);
    }
  }
  return results;
}

/**
 *
 * @param {!string} dataURL
 * @return {{repoInfo: !RepoInfo, path: !Path}}
 */
export const parseRepoInfo = function(
  dataURL: string
): { repoInfo: RepoInfo; path: Path } {
  const parsedUrl = parseURL(dataURL),
    namespace = parsedUrl.subdomain;

  if (parsedUrl.domain === 'firebase') {
    fatal(
      parsedUrl.host +
        ' is no longer supported. ' +
        'Please use <YOUR FIREBASE>.firebaseio.com instead'
    );
  }

  // Catch common error of uninitialized namespace value.
  if (
    (!namespace || namespace == 'undefined') &&
    parsedUrl.domain !== 'localhost'
  ) {
    fatal(
      'Cannot parse Firebase url. Please use https://<YOUR FIREBASE>.firebaseio.com'
    );
  }

  if (!parsedUrl.secure) {
    warnIfPageIsSecure();
  }

  const webSocketOnly = parsedUrl.scheme === 'ws' || parsedUrl.scheme === 'wss';

  return {
    repoInfo: new RepoInfo(
      parsedUrl.host,
      parsedUrl.secure,
      namespace,
      webSocketOnly
    ),
    path: new Path(parsedUrl.pathString)
  };
};

/**
 *
 * @param {!string} dataURL
 * @return {{host: string, port: number, domain: string, subdomain: string, secure: boolean, scheme: string, pathString: string}}
 */
export const parseURL = function(
  dataURL: string
): {
  host: string;
  port: number;
  topLevelDomain: string;
  domain: string;
  subdomain: string;
  secure: boolean;
  scheme: string;
  pathString: string;
} {
  // Default to empty strings in the event of a malformed string.
  let host = '',
    topLevelDomain = '',
    domain = '',
    subdomain = '',
    pathString = '';

  // Always default to SSL, unless otherwise specified.
  let secure = true,
    scheme = 'https',
    port = 443;

  // Don't do any validation here. The caller is responsible for validating the result of parsing.
  if (typeof dataURL === 'string') {
    // Parse scheme.
    let colonInd = dataURL.indexOf('//');
    if (colonInd >= 0) {
      scheme = dataURL.substring(0, colonInd - 1);
      dataURL = dataURL.substring(colonInd + 2);
    }

    // Parse host, path, and query string.
    let slashInd = dataURL.indexOf('/');
    if (slashInd === -1) {
      slashInd = dataURL.length;
    }
    let questionMarkInd = dataURL.indexOf('?');
    if (questionMarkInd === -1) {
      questionMarkInd = dataURL.length;
    }
    host = dataURL.substring(0, Math.min(slashInd, questionMarkInd));
    if (slashInd < questionMarkInd) {
      // For pathString, questionMarkInd will always come after slashInd
      pathString = decodePath(dataURL.substring(slashInd, questionMarkInd));
    }
    let queryParams = decodeQuery(
      dataURL.substring(Math.min(dataURL.length, questionMarkInd))
    );

    // If we have a port, use scheme for determining if it's secure.
    colonInd = host.indexOf(':');
    if (colonInd >= 0) {
      secure = scheme === 'https' || scheme === 'wss';
      port = parseInt(host.substring(colonInd + 1), 10);
    } else {
      colonInd = dataURL.length;
    }

    const parts = host.split('.');
    if (parts.length === 4) {
      // Normalize namespaces to lowercase to share storage / connection.
      domain = parts[2];
      subdomain = parts[0].toLowerCase() + '.' + parts[1].toLowerCase();
      topLevelDomain = parts[3];
    } else if (parts.length === 3) {
      // Normalize namespaces to lowercase to share storage / connection.
      domain = parts[1];
      subdomain = parts[0].toLowerCase();
      topLevelDomain = parts[2];
    } else if (parts.length === 2) {
      domain = parts[0];
    } else if (parts[0].slice(0, colonInd).toLowerCase() === 'localhost') {
      domain = 'localhost';
    }
    // Support `ns` query param if subdomain not already set
    if (subdomain === '' && 'ns' in queryParams) {
      subdomain = queryParams['ns'];
    }
  }


  return {
    host,
    port,
    topLevelDomain,
    domain,
    subdomain,
    secure,
    scheme,
    pathString
  };
};
