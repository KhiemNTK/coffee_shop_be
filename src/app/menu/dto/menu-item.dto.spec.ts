import { CreateMenuItemDto, UpdateMenuItemDto } from './menu-item.dto';

describe('menu display metadata', () => {
  it('allows HTTPS images, plain descriptions and explicit removal', () => {
    expect(
      UpdateMenuItemDto.schema.parse({
        imageUrl: 'https://images.example.com/coffee.jpg',
        description: 'Actual coffee',
      }),
    ).toMatchObject({ description: 'Actual coffee' });
    expect(
      UpdateMenuItemDto.schema.parse({ imageUrl: null, description: null }),
    ).toEqual({ imageUrl: null, description: null });
    expect(
      CreateMenuItemDto.schema.safeParse({
        name: 'Coffee',
        categoryId: '70000000-0000-4000-8000-000000000001',
        price: '25000',
      }).success,
    ).toBe(true);
  });

  it.each([
    'http://images.example.com/item.jpg',
    'javascript:alert(1)',
    'data:image/png;base64,a',
    'https://user:password@example.com/item.jpg',
  ])('rejects unsafe image URL %s', (imageUrl) => {
    expect(UpdateMenuItemDto.schema.safeParse({ imageUrl }).success).toBe(
      false,
    );
  });
});
