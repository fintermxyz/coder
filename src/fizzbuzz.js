/**
 * Generates a sequence of numbers from 1 to n, replacing multiples of 3 with "Fizz",
 * multiples of 5 with "Buzz", and multiples of both with "FizzBuzz".
 *
 * @param {number} n - The upper limit (inclusive) for the sequence.
 * @returns {Array<string | number>} An array containing the generated sequence.
 */
export function fizzBuzz(n) {
  return Array.from({ length: n }, (_, i) => i + 1)
    .map(num => {
      if (num % 3 === 0 && num % 5 === 0) return "FizzBuzz";
      if (num % 3 === 0) return "Fizz";
      if (num % 5 === 0) return "Buzz";
      return num;
    });
}
