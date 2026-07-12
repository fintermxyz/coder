import { fizzBuzz } from '../fizzbuzz';

describe('fizzBuzz', () => {
  test('should return correct sequence for n=15', () => {
    const result = fizzBuzz(15);
    expect(result).toEqual([
      1, 2, 'Fizz', 4, 'Buzz', 'Fizz', 7, 8, 'Fizz', 'Buzz', 11, 'Fizz',
      13, 14, 'FizzBuzz'
    ]);
  });

  test('should return correct sequence for n=1', () => {
    const result = fizzBuzz(1);
    expect(result).toEqual([1]);
  });

  test('should return correct sequence for n=0', () => {
    const result = fizzBuzz(0);
    expect(result).toEqual([]);
  });
});
