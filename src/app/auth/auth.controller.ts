import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import ms from 'ms';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { Employee } from '../../common/decorators/employee.decorator';
import { Cookies } from '../../common/decorators/cookie/cookie.decorator';
import {
  CookiesToken,
  createCsrfToken,
  getAuthCookieOptions,
  getCsrfCookieOptions,
} from '../../common/decorators/cookie/cookie.const';
import type { AuthRequestMetadata, AuthTokenPair } from '../../common/types';
import { AuthService } from './auth.service';
import { SkipAuth } from './auth.decorator';
import { SkipCsrf } from './csrf.decorator';
import { TokenKeys } from './consts/jwt.const';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password.dto';
import { SignInDto, SignInResponseDto, SignUpDto } from './dto/sign.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('sign-up')
  @SkipAuth()
  @SkipCsrf()
  async signUp(
    @Body() dto: SignUpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.authService.signUp(
      dto,
      this.getRequestMetadata(req),
    );
    this.setAuthCookies(res, tokens);
    return tokens;
  }

  @Post('sign-in')
  @SkipAuth()
  @SkipCsrf()
  @ApiResponse({ type: SignInResponseDto })
  async signIn(
    @Body() dto: SignInDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.authService.signIn(
      dto,
      this.getRequestMetadata(req),
    );
    this.setAuthCookies(res, tokens);
    return tokens;
  }

  @Get('me')
  @RequirePermissions()
  getMe(@Employee('employeeId') employeeId: string) {
    return this.authService.getMe(employeeId);
  }

  @Get('me/permissions')
  @RequirePermissions()
  getMyPermissions(@Employee('employeeId') employeeId: string) {
    return this.authService.getMyPermissions(employeeId);
  }

  @Post('logout')
  @SkipAuth()
  @ApiCookieAuth('refreshCookie')
  async logout(
    @Cookies(TokenKeys.REFRESH_TOKEN_KEY) refreshToken: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logout(refreshToken);
    this.clearAuthCookies(res);
    return { message: 'Logout success!' };
  }

  @Post('refresh')
  @SkipAuth()
  @ApiCookieAuth('refreshCookie')
  async refreshToken(
    @Cookies(TokenKeys.REFRESH_TOKEN_KEY) refreshToken: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.authService.refreshToken(
      refreshToken,
      this.getRequestMetadata(req),
    );
    this.setAuthCookies(res, tokens);
    return tokens;
  }

  @Post('forgot-password')
  @SkipAuth()
  @SkipCsrf()
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @SkipAuth()
  @SkipCsrf()
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  private setAuthCookies(res: Response, tokens: AuthTokenPair) {
    const authCookieOptions = getAuthCookieOptions();
    res.cookie(TokenKeys.ACCESS_TOKEN_KEY, tokens.accessToken, {
      ...authCookieOptions,
      maxAge: ms(CookiesToken.ACCESS_TOKEN_EXPIRES_IN),
    });
    res.cookie(TokenKeys.REFRESH_TOKEN_KEY, tokens.refreshToken, {
      ...authCookieOptions,
      maxAge: ms(CookiesToken.REFRESH_TOKEN_EXPIRES_IN),
    });
    res.cookie(
      TokenKeys.CSRF_TOKEN_KEY,
      createCsrfToken(),
      getCsrfCookieOptions(),
    );
  }

  private clearAuthCookies(res: Response) {
    const authCookieOptions = getAuthCookieOptions();
    res.clearCookie(TokenKeys.ACCESS_TOKEN_KEY, authCookieOptions);
    res.clearCookie(TokenKeys.REFRESH_TOKEN_KEY, authCookieOptions);
    res.clearCookie(TokenKeys.CSRF_TOKEN_KEY, getCsrfCookieOptions());
  }

  private getRequestMetadata(req: Request): AuthRequestMetadata {
    return {
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}
