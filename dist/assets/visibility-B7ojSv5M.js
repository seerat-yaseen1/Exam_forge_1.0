import{k as i}from"./index-WHEI2RS3.js";/**
 * @license lucide-react v0.487.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const r=[["path",{d:"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",key:"1rqfz7"}],["path",{d:"M14 2v4a2 2 0 0 0 2 2h4",key:"tnqrlb"}],["path",{d:"M10 9H8",key:"b1mrlr"}],["path",{d:"M16 13H8",key:"t4e002"}],["path",{d:"M16 17H8",key:"z1uh3a"}]],l=i("file-text",r),u=["students","institute","faculty"],a=["students","institute","faculty"],c=["students"];function n(t){return Array.isArray(t)?t.filter(e=>e==="students"||e==="institute"||e==="faculty"):null}function d(t,e){const s=n(t.allowReviewTo);return s?s.includes(e):t.allowReview===!0}function w(t,e){const s=n(t.showResultsTo);return s?s.includes(e):e==="students"?t.showResults===!0:!0}function f(t){return n(t.showResultsTo)??(t.showResults?[...u]:["institute","faculty"])}function h(t){return n(t.allowReviewTo)??(t.allowReview?[...u]:[])}export{a as D,l as F,w as a,h as b,c,f as d,d as r};
