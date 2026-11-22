import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api/server';
import { supplierAHotels, supplierBHotels } from '../src/data/mockHotels';

const noDelay = async (): Promise<void> => {};
const app = createApp({
  suppliers: { supplierADown: false, supplierBDown: false, delay: noDelay },
});

describe('mock supplier endpoints', () => {
  it('no city → all of that supplier’s hotels', async () => {
    const a = await request(app).get('/supplierA/hotels');
    expect(a.status).toBe(200);
    expect(a.body).toEqual(supplierAHotels);

    const b = await request(app).get('/supplierB/hotels');
    expect(b.status).toBe(200);
    expect(b.body).toEqual(supplierBHotels);
  });

  it('city=Delhi is case-insensitive → only delhi hotels', async () => {
    const res = await request(app).get('/supplierA/hotels?city=Delhi');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(supplierAHotels.filter((h) => h.city === 'delhi'));
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('city=%20MUMBAI%20 is trimmed → mumbai hotels', async () => {
    const res = await request(app).get('/supplierB/hotels?city=%20MUMBAI%20');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(supplierBHotels.filter((h) => h.city === 'mumbai'));
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('unknown city → 200 []', async () => {
    const res = await request(app).get('/supplierA/hotels?city=goa');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('blank city → 400 INVALID_CITY', async () => {
    const res = await request(app).get('/supplierA/hotels?city=%20');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CITY');
  });

  it('repeated city → 400 INVALID_CITY', async () => {
    const res = await request(app).get('/supplierA/hotels?city=delhi&city=mumbai');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CITY');
  });

  it('fail=true → 500 SUPPLIER_UNAVAILABLE', async () => {
    const res = await request(app).get('/supplierB/hotels?city=delhi&fail=true');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'SUPPLIER_UNAVAILABLE', message: 'Supplier B is unavailable (simulated)' },
    });
  });

  it('fail=false → 200', async () => {
    const res = await request(app).get('/supplierB/hotels?city=delhi&fail=false');
    expect(res.status).toBe(200);
  });

  it('supplierADown flag → A 500, B 200', async () => {
    const downApp = createApp({
      suppliers: { supplierADown: true, supplierBDown: false, delay: noDelay },
    });

    const a = await request(downApp).get('/supplierA/hotels?city=delhi');
    expect(a.status).toBe(500);
    expect(a.body.error.code).toBe('SUPPLIER_UNAVAILABLE');

    const b = await request(downApp).get('/supplierB/hotels?city=delhi');
    expect(b.status).toBe(200);
  });

  it('items have exactly hotelId, name, price, city, commissionPct', async () => {
    const res = await request(app).get('/supplierA/hotels');
    expect(res.body.length).toBeGreaterThan(0);
    for (const item of res.body) {
      expect(Object.keys(item).sort()).toEqual(
        ['city', 'commissionPct', 'hotelId', 'name', 'price'],
      );
    }
  });
});
