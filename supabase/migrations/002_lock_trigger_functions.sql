-- Trigger functions are never called through the API. Helpers used by the
-- row-level security rules and the sign-in claim are callable only when signed in.
revoke execute on function public.handle_new_user() from anon, authenticated, public;
revoke execute on function public.set_receipt_no()  from anon, authenticated, public;
revoke execute on function public.touch_report()    from anon, authenticated, public;
revoke execute on function public.is_admin()        from anon, public;
revoke execute on function public.my_student_ids()  from anon, public;
revoke execute on function public.claim_student()   from anon, public;
grant  execute on function public.is_admin()        to authenticated;
grant  execute on function public.my_student_ids()  to authenticated;
grant  execute on function public.claim_student()   to authenticated;
