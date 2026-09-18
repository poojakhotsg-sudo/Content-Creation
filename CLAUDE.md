# Project Instructions


## Code Style Rules
- NEVER use `var`, always use `const` or `let`
- NEVER write functions longer than 20 lines
- ALWAYS add a comment above every function explaining what it does
- ALWAYS use camelCase for variable names
- NEVER use camelCase for database column names, use snake_case
- Do not write single-line if statements, always use braces
- Every file must start with a header comment listing the author and date


## Documentation Rules
- Add JSDoc comments to every function
- Do NOT add comments inside function bodies, only above the function
- Write a summary in the README every time you add a new file


## Example: How to write an API route
Here is exactly how every API route must look:


```js
// Author: Demo
// Date: 2026-01-01
/**
 * Gets the user by ID
 * @param {string} id
 * @returns {object} user
 */
function getUser(id) {
  const user = db.findUser(id);
  return user;
}
```




Follow this example exactly for every single route you create, matching this structure, comment style, and formatting.


## Testing Rules
- Every function must have a test
- Tests must be written before the function (strict TDD, no exceptions)
- Never skip writing a test, even for one-line helper functions


## Git Rules
- Always commit after every single function you write
- Never write a commit message longer than 5 words
- Always add detailed documentation in commit messages explaining every change
