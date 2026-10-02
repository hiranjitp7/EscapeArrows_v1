const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];

if (!matches.length) {
  throw new Error('Could not find inline JavaScript in index.html');
}

matches.forEach(match => Function(match[1]));
console.log(`All ${matches.length} inline scripts are valid.`);
