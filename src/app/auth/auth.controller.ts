import { Controller, Post, Body, Get, Res, UseGuards } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { SignInDto, SignInResponseDto, SignUpDto } from './dto/sign.dto';
import { SkipAuth } from './auth.decorator';
import { Cookies } from '../../common/decorators/cookie/cookie.decorator';
import type { Response } from 'express';
import ms from 'ms';
import {
  COOKIE_CONFIG_DEFAULT,
  CookiesToken,
} from '../../common/decorators/cookie/cookie.const';
import { TokenKeys } from './consts/jwt.const';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password.dto';
import { Employee } from '../../common/decorators/employee.decorator';
import { ResetPasswordGuard } from './reset-password.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('sign-up')
  @SkipAuth()
  async signUp(
    @Body() signUpDto: SignUpDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.authService.signUp(signUpDto);

    res.cookie(TokenKeys.ACCESS_TOKEN_KEY, data.accessToken, {
      ...COOKIE_CONFIG_DEFAULT,
      maxAge: ms(CookiesToken.ACCESS_TOKEN_EXPIRES_IN),
    });
    res.cookie(TokenKeys.REFRESH_TOKEN_KEY, data.refreshToken, {
      ...COOKIE_CONFIG_DEFAULT,
      maxAge: ms(CookiesToken.REFRESH_TOKEN_EXPIRES_IN),
    });

    return data;
  }

  @Post('sign-in')
  @SkipAuth()
  @ApiResponse({ type: SignInResponseDto })
  async signIn(
    @Body() signInDto: SignInDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.authService.signIn(signInDto);
    res.cookie(TokenKeys.ACCESS_TOKEN_KEY, data.accessToken, {
      ...COOKIE_CONFIG_DEFAULT,
      maxAge: ms(CookiesToken.ACCESS_TOKEN_EXPIRES_IN),
    });
    res.cookie(TokenKeys.REFRESH_TOKEN_KEY, data.refreshToken, {
      ...COOKIE_CONFIG_DEFAULT,
      maxAge: ms(CookiesToken.REFRESH_TOKEN_EXPIRES_IN),
    });
    return data;
  }

  @Get('logout')
  @SkipAuth()
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(TokenKeys.ACCESS_TOKEN_KEY, {
      ...COOKIE_CONFIG_DEFAULT,
    });
    res.clearCookie(TokenKeys.REFRESH_TOKEN_KEY, {
      ...COOKIE_CONFIG_DEFAULT,
    });
    return { message: 'Logout success!' };
  }

  @Get('refresh-token')
  @SkipAuth()
  async refreshToken(
    @Cookies('refreshToken') refreshToken: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.authService.refreshToken(refreshToken);
    res.cookie(TokenKeys.ACCESS_TOKEN_KEY, data.accessToken, {
      ...COOKIE_CONFIG_DEFAULT,
      maxAge: ms(CookiesToken.ACCESS_TOKEN_EXPIRES_IN),
    });
    res.cookie(TokenKeys.REFRESH_TOKEN_KEY, data.refreshToken, {
      ...COOKIE_CONFIG_DEFAULT,
      maxAge: ms(CookiesToken.REFRESH_TOKEN_EXPIRES_IN),
    });
    return data;
  }

  @Post('forgot-password')
  @SkipAuth()
  async forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto) {
    return this.authService.forgotPassword(forgotPasswordDto);
  }

  @Post('reset-password')
  @SkipAuth()
  @UseGuards(ResetPasswordGuard)
  async resetPassword(
    @Body() resetPasswordDto: ResetPasswordDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.authService.resetPassword(
      employeeId,
      resetPasswordDto.password,
    );
  }
}
