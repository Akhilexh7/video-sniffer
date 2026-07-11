// scratch/test_decipher.js

const sampleJs1 = `
function abc(a) {
  a = a.split("");
  tc.reverse(a, 3);
  tc.splice(a, 1);
  return a.join("");
}
`;

const sampleJs2 = `
var xyz = function(b) {
  var b=tc;
  b = b.split("");
  tc.reverse(b, 3);
  tc.splice(b, 1);
  return b.join("");
};
`;

const regex1 = /(?:function\s+([a-zA-Z0-9$]+)|([a-zA-Z0-9$]+)\s*=\s*function)\s*\(\s*([a-zA-Z0-9$]+)\s*\)\s*\{\s*[^{}]*?[a-zA-Z0-9$]+\s*=\s*[a-zA-Z0-9$]+\.split\(\s*["'"]["'"]\s*\)\s*[;,]\s*([\s\S]+?)return\s+[a-zA-Z0-9$]+\.join\(\s*["'"]["'"]\s*\)\s*;?\s*\}/;

const m1 = sampleJs1.match(regex1);
console.log("sampleJs1 groups:");
console.log("Func Name (Group 1):", m1[1]);
console.log("Func Name (Group 2):", m1[2]);
console.log("Param Name (Group 3):", m1[3]);
console.log("Body (Group 4):", m1[4]);

const m2 = sampleJs2.match(regex1);
console.log("sampleJs2 groups:");
console.log("Func Name (Group 1):", m2[1]);
console.log("Func Name (Group 2):", m2[2]);
console.log("Param Name (Group 3):", m2[3]);
console.log("Body (Group 4):", m2[4]);
