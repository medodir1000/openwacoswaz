import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, MaxLength, IsUrl, ValidateIf, IsInt, Min, Max, IsBoolean } from 'class-validator';

export class SendTextMessageDto {
  @ApiProperty({
    description: 'WhatsApp chat ID (phone@c.us for individual, groupId@g.us for groups)',
    example: '628123456789@c.us',
  })
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty({
    description: 'Text message content',
    example: 'Hello from OpenWA!',
    maxLength: 4096,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text: string;

  // ── Human-like delivery (codhelix bot) ──
  // Show "typing…" in WhatsApp for this many ms BEFORE the message
  // actually lands. Bot calls this with a value proportional to the
  // reply length so customers see a believable composition delay.
  @ApiPropertyOptional({
    description: 'Show "typing..." indicator for N ms before delivering the message (0 = off).',
    example: 3500, minimum: 0, maximum: 30000,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30000)
  typingMs?: number;

  // Mark the chat as "seen" (blue ticks for the inbound message) before
  // we start typing. Pure UX touch — makes the bot feel like an attentive
  // human who reads first, thinks, then types.
  @ApiPropertyOptional({
    description: 'Send a read-receipt (mark inbound messages as seen) before typing.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  markSeen?: boolean;
}

export class SendMediaMessageDto {
  @ApiProperty({
    description: 'WhatsApp chat ID',
    example: '628123456789@c.us',
  })
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiPropertyOptional({
    description: 'Media URL (http/https)',
    example: 'https://example.com/image.jpg',
  })
  @IsOptional()
  @IsUrl()
  @ValidateIf((o: SendMediaMessageDto) => !o.base64)
  url?: string;

  @ApiPropertyOptional({
    description: 'Base64 encoded media data',
  })
  @IsOptional()
  @IsString()
  @ValidateIf((o: SendMediaMessageDto) => !o.url)
  base64?: string;

  @ApiPropertyOptional({
    description: 'Media MIME type (required when using base64)',
    example: 'image/jpeg',
  })
  @IsOptional()
  @IsString()
  mimetype?: string;

  @ApiPropertyOptional({
    description: 'Filename for the media',
    example: 'image.jpg',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;

  @ApiPropertyOptional({
    description: 'Caption for the media',
    example: 'Check out this image!',
    maxLength: 1024,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  caption?: string;
}

export class MessageResponseDto {
  @ApiProperty({ example: 'true_628123456789@c.us_3EB0123456789' })
  messageId: string;

  @ApiProperty({ example: 1706868000 })
  timestamp: number;
}
