const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function calendarDate(iso: string) {
  const [year, month, day] = iso.split('-');
  return Number(day) + ' ' + months[Number(month) - 1] + ' ' + year;
}
