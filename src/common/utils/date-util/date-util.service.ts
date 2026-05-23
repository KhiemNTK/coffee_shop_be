import { Injectable } from '@nestjs/common';

@Injectable()
export class DateUtilService {
  getCurrentDate(
    locales: Intl.LocalesArgument = 'en-GB',
    format?: Intl.DateTimeFormatOptions,
  ) {
    return this.formatDate(new Date(), locales, format);
  }

  formatDate(
    date: Date,
    locales: Intl.LocalesArgument = 'en-GB',
    format: Intl.DateTimeFormatOptions = {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    },
  ) {
    const data = new Intl.DateTimeFormat(locales, format).format(date);
    return data;
  }
}
