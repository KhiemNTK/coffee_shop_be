import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
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
import type {
  AuthenticatedStaffRequest,
  AuthRequestMetadata,
  AuthTokenPair,
} from '../../common/types';
import { AuthService } from './auth.service';
import { SkipAuth } from './auth.decorator';
import { SkipCsrf } from './csrf.decorator';
import { TokenKeys } from './consts/jwt.const';
import { LoginRequestGuard } from './login-request.guard';
import {
  ForgotPasswordDto,
  GoogleLinkDto,
  GoogleSignInDto,
  GoogleUnlinkDto,
  ResetPasswordDto,
  SignInDto,
  SignInResponseDto,
  SignUpDto,
} from './dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('sign-up')
  @UseGuards(LoginRequestGuard)
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
  @UseGuards(LoginRequestGuard)
  @SkipAuth()
  @SkipCsrf()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
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

  @Post('google')
  @UseGuards(LoginRequestGuard)
  @SkipAuth()
  @SkipCsrf()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiResponse({ type: SignInResponseDto })
  async signInWithGoogle(
    @Body() dto: GoogleSignInDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.authService.signInWithGoogle(
      dto,
      this.getRequestMetadata(req),
    );
    this.setAuthCookies(res, tokens);
    return tokens;
  }

  @Post('google/link')
  @RequirePermissions()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  linkGoogle(
    @Employee('employeeId') employeeId: string,
    @Body() dto: GoogleLinkDto,
  ) {
    return this.authService.linkGoogle(employeeId, dto);
  }

  @Post('google/unlink')
  @RequirePermissions()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async unlinkGoogle(
    @Employee('employeeId') employeeId: string,
    @Body() dto: GoogleUnlinkDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.unlinkGoogle(employeeId, dto);
    this.clearAuthCookies(res);
    return result;
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions()
  getMe(
    @Employee('employeeId') employeeId: string,
    @Req() request: AuthenticatedStaffRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const csrf: unknown = request.cookies?.[TokenKeys.CSRF_TOKEN_KEY];
    if (
      request.authMethod === 'cookie' &&
      (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrf))
    )
      this.setCsrfCookie(response);
    return this.authService.getMe(employeeId);
  }

  @Get('me/permissions')
  @Header('Cache-Control', 'no-store')
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
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.authService.forgotPassword(dto, this.getRequestMetadata(req));
  }

  @Post('reset-password')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
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
    this.setCsrfCookie(res);
  }

  private setCsrfCookie(res: Response) {
    res.cookie(TokenKeys.CSRF_TOKEN_KEY, createCsrfToken(), {
      ...getCsrfCookieOptions(),
      maxAge: ms(CookiesToken.REFRESH_TOKEN_EXPIRES_IN),
    });
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
