const LONG_MONTHS = new Set([1, 3, 5, 7, 8, 10, 12]);

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year, month) {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return LONG_MONTHS.has(month) ? 31 : 30;
}
